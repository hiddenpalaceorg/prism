using uniffi.prism_ffi;

namespace PrismWin;

/// UI wrapper over the FFI `FileNode` for the TreeView (name, icon, children).
public sealed class DiscNodeVm
{
    public FileNode Node { get; }
    public List<DiscNodeVm> Children { get; }
    public bool IsRoot { get; }

    public DiscNodeVm(FileNode node, bool isRoot = false)
    {
        Node = node;
        IsRoot = isRoot;
        Children = node.Children.Select(c => new DiscNodeVm(c)).ToList();
    }

    public string Name => Node.Name;

    /// Segoe Fluent Icons: folder vs page.
    public string Glyph => Node.IsDir ? "\uE8B7" : "\uE7C3";
}

/// One library row, preformatted for the browser list.
public sealed class LibraryRowVm
{
    public LibraryEntry Entry { get; }

    public LibraryRowVm(LibraryEntry entry)
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
