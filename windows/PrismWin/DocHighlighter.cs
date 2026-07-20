using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace PrismWin;

/// Colors the DAT/JSON pane. A plain scanner, not a parser: good enough for
/// machine-generated documents and it never throws on malformed input.
/// Split in two so the scan can run off the UI thread: Tokenize (pure) emits
/// coalesced spans, Apply (UI thread) turns them into runs. Callers cap input
/// at MaxChars; RichTextBlock has no virtualization, so size must stay bounded.
internal static class DocHighlighter
{
    public const int MaxChars = 120_000;

    private const byte KindDefault = 0;
    private const byte KindElement = 1;
    private const byte KindAttr = 2;
    private const byte KindStr = 3;
    private const byte KindNum = 4;
    private const byte KindComment = 5;
    private const byte KindPunct = 6;

    public readonly record struct Span(int Start, int Length, byte Kind);

    // Indexed by kind; KindDefault is null (inherit the control's foreground).
    private static readonly Color?[] Light =
    {
        null,
        Color.FromArgb(255, 0x0B, 0x6B, 0xCB),
        Color.FromArgb(255, 0x7A, 0x4C, 0xB0),
        Color.FromArgb(255, 0xA3, 0x15, 0x15),
        Color.FromArgb(255, 0x09, 0x86, 0x58),
        Color.FromArgb(255, 0x44, 0x80, 0x44),
        Color.FromArgb(255, 0x6E, 0x6E, 0x6E),
    };

    private static readonly Color?[] Dark =
    {
        null,
        Color.FromArgb(255, 0x6C, 0xB8, 0xFF),
        Color.FromArgb(255, 0xC8, 0x9A, 0xE8),
        Color.FromArgb(255, 0xCE, 0x91, 0x78),
        Color.FromArgb(255, 0xB5, 0xCE, 0xA8),
        Color.FromArgb(255, 0x6A, 0x99, 0x55),
        Color.FromArgb(255, 0x9A, 0x9A, 0x9A),
    };

    /// Pure compute, safe for Task.Run.
    public static List<Span> Tokenize(string text, bool isJson)
    {
        var sink = new SpanSink();
        if (isJson)
        {
            Json(text, sink);
        }
        else
        {
            Xml(text, sink);
        }
        return sink.Finish();
    }

    /// UI thread: replaces `target`'s content with colored runs.
    public static void Apply(RichTextBlock target, string text, List<Span> spans, bool dark)
    {
        var palette = dark ? Dark : Light;
        var brushes = new Brush?[palette.Length];
        for (var k = 0; k < palette.Length; k++)
        {
            brushes[k] = palette[k] is { } c ? new SolidColorBrush(c) : null;
        }
        var para = new Paragraph();
        foreach (var span in spans)
        {
            var run = new Run { Text = text.Substring(span.Start, span.Length) };
            if (brushes[span.Kind] is { } brush)
            {
                run.Foreground = brush;
            }
            para.Inlines.Add(run);
        }
        target.Blocks.Clear();
        target.Blocks.Add(para);
    }

    private static void Xml(string t, SpanSink sink)
    {
        var n = t.Length;
        var i = 0;
        while (i < n)
        {
            if (t[i] != '<')
            {
                sink.Add(1, KindDefault);
                i++;
                continue;
            }
            if (Starts(t, i, "<!--"))
            {
                var end = t.IndexOf("-->", i + 4, StringComparison.Ordinal);
                end = end < 0 ? n : end + 3;
                sink.Add(end - i, KindComment);
                i = end;
                continue;
            }
            if (Starts(t, i, "<!"))
            {
                var end = t.IndexOf('>', i);
                end = end < 0 ? n : end + 1;
                sink.Add(end - i, KindComment);
                i = end;
                continue;
            }
            // Tag: leading punctuation, element name, then attributes.
            var j = i + 1;
            while (j < n && (t[j] == '/' || t[j] == '?'))
            {
                j++;
            }
            sink.Add(j - i, KindPunct);
            i = j;
            while (i < n && !IsNameEnd(t[i]))
            {
                i++;
            }
            sink.Add(i - j, KindElement);
            while (i < n && t[i] != '>')
            {
                var c = t[i];
                if (c == '"' || c == '\'')
                {
                    var q = t.IndexOf(c, i + 1);
                    var end = q < 0 ? n : q + 1;
                    sink.Add(end - i, KindStr);
                    i = end;
                }
                else if (char.IsWhiteSpace(c) || c == '=' || c == '/' || c == '?')
                {
                    sink.Add(1, KindPunct);
                    i++;
                }
                else
                {
                    var s = i;
                    while (i < n && t[i] != '=' && t[i] != '>' && !char.IsWhiteSpace(t[i]))
                    {
                        i++;
                    }
                    sink.Add(i - s, KindAttr);
                }
            }
            if (i < n)
            {
                sink.Add(1, KindPunct);
                i++;
            }
        }
    }

    private static void Json(string t, SpanSink sink)
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
                sink.Add(i - s, k < n && t[k] == ':' ? KindElement : KindStr);
            }
            else if (c == '-' || char.IsAsciiDigit(c))
            {
                var s = i;
                while (i < n && (char.IsAsciiDigit(t[i]) || t[i] is '.' or '-' or '+' or 'e' or 'E'))
                {
                    i++;
                }
                sink.Add(i - s, KindNum);
            }
            else if (char.IsAsciiLetter(c))
            {
                var s = i;
                while (i < n && char.IsAsciiLetter(t[i]))
                {
                    i++;
                }
                var keyword = t.AsSpan(s, i - s) is "true" or "false" or "null";
                sink.Add(i - s, keyword ? KindNum : KindDefault);
            }
            else
            {
                sink.Add(1, char.IsWhiteSpace(c) ? KindDefault : KindPunct);
                i++;
            }
        }
    }

    private static bool IsNameEnd(char c) => char.IsWhiteSpace(c) || c is '>' or '/' or '?';

    private static bool Starts(string t, int i, string s) =>
        i + s.Length <= t.Length && t.AsSpan(i, s.Length).SequenceEqual(s);

    /// Coalesces consecutive same-kind stretches, so a whole attribute costs
    /// one span rather than one per character.
    private sealed class SpanSink
    {
        private readonly List<Span> _spans = new();
        private int _pos;
        private int _start;
        private byte _kind = byte.MaxValue;

        public void Add(int length, byte kind)
        {
            if (length <= 0)
            {
                return;
            }
            if (kind != _kind)
            {
                Flush();
                _kind = kind;
                _start = _pos;
            }
            _pos += length;
        }

        private void Flush()
        {
            if (_pos > _start)
            {
                _spans.Add(new Span(_start, _pos - _start, _kind));
            }
        }

        public List<Span> Finish()
        {
            Flush();
            return _spans;
        }
    }
}
