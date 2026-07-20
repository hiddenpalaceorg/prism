using System.Globalization;
using System.Text;

namespace PrismWin;

/// Display formatting shared across the app, matching the other front-ends.
internal static class Format
{
    private static readonly string[] Units = { "B", "KB", "MB", "GB", "TB" };

    public static string HumanSize(ulong? bytes)
    {
        if (bytes is not { } b)
        {
            return "—";
        }
        if (b < 1024)
        {
            return $"{b} B";
        }
        var value = (double)b;
        var i = 0;
        while (value >= 1024 && i < Units.Length - 1)
        {
            value /= 1024;
            i++;
        }
        return string.Format(CultureInfo.InvariantCulture, "{0:0.0} {1}", value, Units[i]);
    }

    /// `19970414` → `1997-04-14`; anything else is returned unchanged.
    public static string? PrettyDate(string? s)
    {
        if (string.IsNullOrEmpty(s))
        {
            return null;
        }
        if (s.Length == 8 && s.All(char.IsAsciiDigit))
        {
            return $"{s[..4]}-{s[4..6]}-{s[6..]}";
        }
        return s;
    }

    /// Unix seconds → a short relative string like "3d ago".
    public static string RelativeDate(long unix)
    {
        var then = DateTimeOffset.FromUnixTimeSeconds(unix);
        var delta = DateTimeOffset.Now - then;
        if (delta.TotalSeconds < 60)
        {
            return "now";
        }
        if (delta.TotalMinutes < 60)
        {
            return $"{(int)delta.TotalMinutes}m ago";
        }
        if (delta.TotalHours < 24)
        {
            return $"{(int)delta.TotalHours}h ago";
        }
        if (delta.TotalDays < 30)
        {
            return $"{(int)delta.TotalDays}d ago";
        }
        if (delta.TotalDays < 365)
        {
            return $"{(int)(delta.TotalDays / 30)}mo ago";
        }
        return $"{(int)(delta.TotalDays / 365)}y ago";
    }

    /// Classic xxd layout: 8-hex offset, 16 bytes as 2-byte groups, ASCII gutter.
    public static string HexDump(byte[] data)
    {
        var sb = new StringBuilder(data.Length * 5);
        for (var offset = 0; offset < data.Length; offset += 16)
        {
            sb.Append($"{offset:x8}: ");
            var end = Math.Min(offset + 16, data.Length);
            for (var j = 0; j < 16; j++)
            {
                sb.Append(offset + j < end ? $"{data[offset + j]:x2}" : "  ");
                if (j % 2 == 1)
                {
                    sb.Append(' ');
                }
            }
            sb.Append(' ');
            for (var i = offset; i < end; i++)
            {
                var b = data[i];
                sb.Append(b >= 0x20 && b < 0x7f ? (char)b : '.');
            }
            sb.Append('\n');
        }
        return sb.ToString();
    }

    /// The last path component of a forward-slash record path.
    public static string LastComponent(string path)
    {
        var i = path.LastIndexOf('/');
        return i < 0 ? path : path[(i + 1)..];
    }
}
