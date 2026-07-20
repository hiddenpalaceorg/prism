using Microsoft.UI.Xaml.Media;
using Windows.UI;
using uniffi.prism_ffi;

namespace PrismWin;

/// UI wrapper over the FFI `FileNode` for the TreeView (name, icon, children).
public sealed class DiscNodeVm
{
    // FFI types are internal (same assembly as the generated bindings); the
    // class stays public so the XAML compiler can resolve x:DataType.
    internal FileNode Node { get; }
    public List<DiscNodeVm> Children { get; }
    public bool IsRoot { get; }

    internal DiscNodeVm(FileNode node, bool isRoot = false)
    {
        Node = node;
        IsRoot = isRoot;
        Children = node.Children.Select(c => new DiscNodeVm(c)).ToList();
    }

    public string Name => Node.Name;

    public string Glyph => FileIcon.GlyphFor(Node);

    public Brush IconBrush => FileIcon.BrushFor(Node);
}

/// Segoe Fluent glyph plus a per-category tint (VS Code file-tree style), so
/// the tree reads at a glance instead of as a wall of gray pages.
/// UI-thread only (brushes are created and cached lazily).
internal static class FileIcon
{
    private static readonly (string Glyph, Color Color) Folder = ("\uE8B7", Rgb(0xE0, 0xA0, 0x30));
    private static readonly (string Glyph, Color Color) Page = ("\uE7C3", Rgb(0x8E, 0x8E, 0x93));
    private static readonly Dictionary<string, (string Glyph, Color Color)> ByExt = BuildMap();
    private static readonly Dictionary<Color, SolidColorBrush> Brushes = new();

    public static string GlyphFor(FileNode node) =>
        node.IsDir ? Folder.Glyph : Lookup(node.Name).Glyph;

    public static Brush BrushFor(FileNode node) =>
        BrushOf(node.IsDir ? Folder.Color : Lookup(node.Name).Color);

    private static (string Glyph, Color Color) Lookup(string name)
    {
        var ext = Path.GetExtension(name);
        return ext.Length > 1 && ByExt.TryGetValue(ext[1..], out var hit) ? hit : Page;
    }

    private static Dictionary<string, (string, Color)> BuildMap()
    {
        var map = new Dictionary<string, (string, Color)>(StringComparer.OrdinalIgnoreCase);
        void Add(string glyph, Color color, params string[] exts)
        {
            foreach (var e in exts)
            {
                map[e] = (glyph, color);
            }
        }
        Add("\uE91B", Rgb(0x2F, 0xA1, 0x73),
            "png", "jpg", "jpeg", "gif", "bmp", "tga", "tif", "tiff", "pcx", "ico", "webp");
        Add("\uE8D6", Rgb(0x9A, 0x6B, 0xD0),
            "wav", "mp3", "ogg", "flac", "xa", "adx", "aif", "aiff", "mid", "midi", "wma");
        Add("\uE714", Rgb(0xE0, 0x59, 0x6E),
            "mpg", "mpeg", "avi", "mov", "mp4", "mkv", "bik", "vob", "pss", "str", "m2v", "wmv");
        Add("\uE756", Rgb(0x5C, 0x8D, 0xDA),
            "exe", "dll", "elf", "self", "xbe", "dol", "com", "bat", "cmd");
        Add("\uE943", Rgb(0x4F, 0x97, 0xC4),
            "c", "cpp", "h", "hpp", "asm", "s", "inc", "js", "lua", "py",
            "xml", "json", "ini", "cfg", "inf", "html", "htm", "css");
        Add("\uE8F1", Rgb(0xB0, 0x80, 0x50),
            "zip", "7z", "rar", "gz", "bz2", "tar", "lzh", "arc", "cab");
        Add("\uE8A5", Rgb(0xC7, 0x5A, 0x3B), "pdf", "doc", "rtf", "eps");
        return map;
    }

    private static Color Rgb(byte r, byte g, byte b) => Color.FromArgb(255, r, g, b);

    private static SolidColorBrush BrushOf(Color color)
    {
        if (!Brushes.TryGetValue(color, out var brush))
        {
            brush = new SolidColorBrush(color);
            Brushes[color] = brush;
        }
        return brush;
    }
}

/// One library row, preformatted for the browser list.
public sealed class LibraryRowVm
{
    internal LibraryEntry Entry { get; }

    internal LibraryRowVm(LibraryEntry entry)
    {
        Entry = entry;
    }

    public string Name => Entry.Name;
    public string System => Entry.System;
    public string FilesText => Entry.FileCount.ToString();
    public string SizeText => Format.HumanSize(Entry.TotalSize);
    public string DateText => Format.RelativeDate(Entry.AnalyzedAt);
}

/// A single live progress counter (image hashing, per-archive extraction, …).
public sealed class CounterVm
{
    public ulong Id { get; init; }
    public string Label { get; set; } = "";
    public double? Total { get; set; }
    public double Count { get; set; }

    public double? Fraction => Total is { } t and > 0 ? Math.Min(1.0, Count / t) : null;
}
