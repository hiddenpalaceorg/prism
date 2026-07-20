using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace PrismWin;

/// Per-system identity colors. The hero tile, header wash, system badge, and
/// library chips all key off the detected system, so identification reads as
/// an event instead of a gray label. Unknown builds keep the prism gradient.
/// UI-thread only (brushes are created and cached lazily).
internal static class SystemTheme
{
    public static readonly (Color A, Color B) Default = (Rgb(0x8B, 0x5C, 0xF6), Rgb(0x3B, 0x82, 0xF6));

    // Keys are the adapter's raw system codes (processor.get_system_type).
    private static readonly Dictionary<string, (Color A, Color B)> Map = new(StringComparer.OrdinalIgnoreCase)
    {
        ["ps1"] = (Rgb(0x66, 0x77, 0xC4), Rgb(0x3D, 0x4C, 0x9E)),
        ["ps2"] = (Rgb(0x3B, 0x82, 0xF6), Rgb(0x1D, 0x4E, 0xD8)),
        ["ps3"] = (Rgb(0x60, 0x6C, 0x8C), Rgb(0x37, 0x41, 0x5C)),
        ["psp"] = (Rgb(0x7C, 0x5C, 0xF6), Rgb(0x4F, 0x38, 0xC9)),
        ["saturn"] = (Rgb(0x7E, 0x6B, 0xC9), Rgb(0x54, 0x43, 0x99)),
        ["megacd"] = (Rgb(0xF4, 0x51, 0x5C), Rgb(0xC6, 0x2B, 0x38)),
        ["dreamcast"] = (Rgb(0xFB, 0x8C, 0x3C), Rgb(0xE8, 0x5D, 0x1A)),
        ["gamecube"] = (Rgb(0x8A, 0x70, 0xD6), Rgb(0x5E, 0x48, 0xB0)),
        ["wii"] = (Rgb(0x38, 0xBD, 0xF8), Rgb(0x0E, 0x8E, 0xD0)),
        ["xbox"] = (Rgb(0x3C, 0xB0, 0x43), Rgb(0x10, 0x7C, 0x10)),
        ["xbox360"] = (Rgb(0x5F, 0xB9, 0x4A), Rgb(0x2E, 0x8B, 0x2E)),
        ["xbla"] = (Rgb(0x5F, 0xB9, 0x4A), Rgb(0x2E, 0x8B, 0x2E)),
        ["3do"] = (Rgb(0xE8, 0x5D, 0x75), Rgb(0xC2, 0x3A, 0x52)),
        ["cdi"] = (Rgb(0x00, 0xA8, 0x9D), Rgb(0x00, 0x77, 0x70)),
        ["cd32"] = (Rgb(0xD9, 0x53, 0x3E), Rgb(0xA8, 0x35, 0x28)),
        ["pc"] = (Rgb(0x5C, 0x8D, 0xDA), Rgb(0x2F, 0x5F, 0xB3)),
    };

    private static readonly Dictionary<(Color, byte), SolidColorBrush> Cache = new();

    public static (Color A, Color B) For(string? system) =>
        system != null && Map.TryGetValue(system.Trim(), out var hit) ? hit : Default;

    public static bool IsKnown(string? system) => system != null && Map.ContainsKey(system.Trim());

    /// Translucent wash of the color (badge and chip backgrounds).
    public static SolidColorBrush TintBrush(Color c, byte alpha) => BrushOf(c, alpha);

    public static SolidColorBrush SolidBrush(Color c) => BrushOf(c, 255);

    /// Text/icon shade that stays legible on the matching tint: darker on the
    /// light theme, lighter on the dark theme.
    public static Color OnTint(Color c, bool dark) => dark ? Mix(c, Colors.White, 0.45) : Mix(c, Colors.Black, 0.30);

    public static Color Mix(Color c, Color toward, double f) => Color.FromArgb(255,
        (byte)(c.R + (toward.R - c.R) * f),
        (byte)(c.G + (toward.G - c.G) * f),
        (byte)(c.B + (toward.B - c.B) * f));

    private static Color Rgb(byte r, byte g, byte b) => Color.FromArgb(255, r, g, b);

    private static SolidColorBrush BrushOf(Color c, byte alpha)
    {
        if (!Cache.TryGetValue((c, alpha), out var brush))
        {
            brush = new SolidColorBrush(Color.FromArgb(alpha, c.R, c.G, c.B));
            Cache[(c, alpha)] = brush;
        }
        return brush;
    }
}
