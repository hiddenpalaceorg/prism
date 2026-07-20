using System.Text;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace PrismWin;

/// Colors the DAT/JSON pane. A plain scanner, not a parser: good enough for
/// machine-generated documents and it never throws on malformed input. Very
/// large documents fall back to the plain read-only TextBox (RichTextBlock
/// has no virtualization, so run count must stay bounded).
internal static class DocHighlighter
{
    private const int MaxChars = 300_000;
    private const int MaxRuns = 40_000;

    private readonly record struct Palette(
        Color Element, Color Attr, Color Str, Color Num, Color Comment, Color Punct);

    private static readonly Palette Light = new(
        Color.FromArgb(255, 0x0B, 0x6B, 0xCB),
        Color.FromArgb(255, 0x7A, 0x4C, 0xB0),
        Color.FromArgb(255, 0xA3, 0x15, 0x15),
        Color.FromArgb(255, 0x09, 0x86, 0x58),
        Color.FromArgb(255, 0x44, 0x80, 0x44),
        Color.FromArgb(255, 0x6E, 0x6E, 0x6E));

    private static readonly Palette Dark = new(
        Color.FromArgb(255, 0x6C, 0xB8, 0xFF),
        Color.FromArgb(255, 0xC8, 0x9A, 0xE8),
        Color.FromArgb(255, 0xCE, 0x91, 0x78),
        Color.FromArgb(255, 0xB5, 0xCE, 0xA8),
        Color.FromArgb(255, 0x6A, 0x99, 0x55),
        Color.FromArgb(255, 0x9A, 0x9A, 0x9A));

    /// Replaces `target`'s content with colored runs; false means "too big,
    /// show it plain instead".
    public static bool TryHighlight(RichTextBlock target, string text, bool isJson, bool dark)
    {
        if (text.Length > MaxChars)
        {
            return false;
        }
        var pal = dark ? Dark : Light;
        var em = new Emitter();
        if (isJson)
        {
            Json(text, pal, em);
        }
        else
        {
            Xml(text, pal, em);
        }
        var runs = em.Finish();
        if (runs.Count > MaxRuns)
        {
            return false;
        }
        var para = new Paragraph();
        foreach (var run in runs)
        {
            para.Inlines.Add(run);
        }
        target.Blocks.Clear();
        target.Blocks.Add(para);
        return true;
    }

    private static void Xml(string t, Palette p, Emitter em)
    {
        var n = t.Length;
        var i = 0;
        while (i < n)
        {
            if (t[i] != '<')
            {
                em.Add(t[i], null);
                i++;
                continue;
            }
            if (Starts(t, i, "<!--"))
            {
                var end = t.IndexOf("-->", i + 4, StringComparison.Ordinal);
                end = end < 0 ? n : end + 3;
                em.Add(t[i..end], p.Comment);
                i = end;
                continue;
            }
            if (Starts(t, i, "<!"))
            {
                var end = t.IndexOf('>', i);
                end = end < 0 ? n : end + 1;
                em.Add(t[i..end], p.Comment);
                i = end;
                continue;
            }
            // Tag: leading punctuation, element name, then attributes.
            var j = i + 1;
            while (j < n && (t[j] == '/' || t[j] == '?'))
            {
                j++;
            }
            em.Add(t[i..j], p.Punct);
            i = j;
            while (i < n && !IsNameEnd(t[i]))
            {
                i++;
            }
            em.Add(t[j..i], p.Element);
            while (i < n && t[i] != '>')
            {
                var c = t[i];
                if (c == '"' || c == '\'')
                {
                    var q = t.IndexOf(c, i + 1);
                    var end = q < 0 ? n : q + 1;
                    em.Add(t[i..end], p.Str);
                    i = end;
                }
                else if (char.IsWhiteSpace(c) || c == '=' || c == '/' || c == '?')
                {
                    em.Add(c, p.Punct);
                    i++;
                }
                else
                {
                    var s = i;
                    while (i < n && t[i] != '=' && t[i] != '>' && !char.IsWhiteSpace(t[i]))
                    {
                        i++;
                    }
                    em.Add(t[s..i], p.Attr);
                }
            }
            if (i < n)
            {
                em.Add('>', p.Punct);
                i++;
            }
        }
    }

    private static void Json(string t, Palette p, Emitter em)
    {
        var n = t.Length;
        var i = 0;
        while (i < n)
        {
            var c = t[i];
            if (c == '"')
            {
                var s = i;
                i++;
                while (i < n && t[i] != '"')
                {
                    i += t[i] == '\\' ? 2 : 1;
                }
                i = Math.Min(i + 1, n);
                var k = i;
                while (k < n && char.IsWhiteSpace(t[k]))
                {
                    k++;
                }
                em.Add(t[s..i], k < n && t[k] == ':' ? p.Element : p.Str);
            }
            else if (c == '-' || char.IsAsciiDigit(c))
            {
                var s = i;
                while (i < n && (char.IsAsciiDigit(t[i]) || t[i] is '.' or '-' or '+' or 'e' or 'E'))
                {
                    i++;
                }
                em.Add(t[s..i], p.Num);
            }
            else if (char.IsAsciiLetter(c))
            {
                var s = i;
                while (i < n && char.IsAsciiLetter(t[i]))
                {
                    i++;
                }
                var word = t[s..i];
                em.Add(word, word is "true" or "false" or "null" ? p.Num : null);
            }
            else
            {
                em.Add(c, char.IsWhiteSpace(c) ? null : p.Punct);
                i++;
            }
        }
    }

    private static bool IsNameEnd(char c) => char.IsWhiteSpace(c) || c is '>' or '/' or '?';

    private static bool Starts(string t, int i, string s) =>
        i + s.Length <= t.Length && t.AsSpan(i, s.Length).SequenceEqual(s);

    /// Buffers characters and flushes one Run per color change, so a whole
    /// attribute costs a run or two rather than one per character. A null
    /// color inherits the control's foreground.
    private sealed class Emitter
    {
        private readonly List<Run> _runs = new();
        private readonly StringBuilder _buf = new();
        private readonly Dictionary<Color, SolidColorBrush> _brushes = new();
        private Color? _color;

        public void Add(char c, Color? color)
        {
            if (color != _color)
            {
                Flush(color);
            }
            _buf.Append(c);
        }

        public void Add(string s, Color? color)
        {
            if (s.Length == 0)
            {
                return;
            }
            if (color != _color)
            {
                Flush(color);
            }
            _buf.Append(s);
        }

        private void Flush(Color? next)
        {
            if (_buf.Length > 0)
            {
                var run = new Run { Text = _buf.ToString() };
                if (_color is { } c)
                {
                    if (!_brushes.TryGetValue(c, out var brush))
                    {
                        brush = new SolidColorBrush(c);
                        _brushes[c] = brush;
                    }
                    run.Foreground = brush;
                }
                _runs.Add(run);
                _buf.Clear();
            }
            _color = next;
        }

        public List<Run> Finish()
        {
            Flush(null);
            return _runs;
        }
    }
}
