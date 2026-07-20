using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.ApplicationModel.DataTransfer;
using Windows.Media.Core;
using Windows.Storage.Pickers;
using Windows.Storage.Streams;
using uniffi.prism_ffi;

namespace PrismWin;

public sealed partial class MainWindow : Window
{
    private readonly PrismService _service = new();
    private readonly object _engineLock = new();
    private Engine? _engine;
    private CancelHandle? _cancel;
    private bool _working;
    private bool _importing;
    private bool _libraryMode;
    private bool _isQuerying;

    private AnalysisSummary? _summary;
    private RecordDoc? _record;
    private List<AssetInfo> _assets = new();
    private SimilarityResponse? _similarity;

    private readonly List<CounterVm> _counters = new();
    private readonly Dictionary<ulong, ProgressBar> _counterBars = new();

    private List<string> _librarySystems = new();
    private LibrarySort _librarySort = LibrarySort.Date;
    private bool _librarySortDesc = true;
    private readonly Dictionary<LibrarySort, (Button Button, FontIcon Icon)> _libHeaders = new();

    private MediaPlayerElement? _activeMedia;
    private string? _previewText;
    private AssetInfo? _previewAsset;
    private (AnalysisSummary Summary, bool Json, bool Dark)? _docShown;

    public MainWindow()
    {
        InitializeComponent();
        Title = "Prism";
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "prism.ico"));
        AppWindow.Resize(new Windows.Graphics.SizeInt32 { Width = 1200, Height = 800 });
        BuildLibraryHeader();
        TabBar.SelectedItem = TabOverview;
        DocModeBar.SelectedItem = DocModeXml;
        // The highlight palette is theme-specific, so recolor if the theme flips.
        Root.ActualThemeChanged += (_, _) =>
        {
            _docShown = null;
            EnsureDocText();
        };
        _ = InitializeLibraryAsync();
        MaybeStartScreenshotRun();
    }

    // ---- engine ----

    /// Build the engine on demand (opens the library DB; adapters launch lazily).
    /// Called from worker threads; the lock keeps construction single.
    private Engine GetEngine()
    {
        lock (_engineLock)
        {
            if (_engine == null)
            {
                var (dir, bin) = AdapterLocator.Resolve();
                _engine = new Engine(dir, bin, Environment.GetEnvironmentVariable("PRISM_DATA_DIR"));
            }
            return _engine;
        }
    }

    private static string ErrorMessage(Exception ex) =>
        ex is PrismException.Failed f ? f.message : ex.Message;

    private void Enqueue(Action action) => DispatcherQueue.TryEnqueue(() => action());

    private void SetStatus(string text) => StatusText.Text = text;

    private void SetWorking(bool working)
    {
        _working = working;
        BusyRing.IsActive = working || _isQuerying;
        MenuCancel.IsEnabled = working;
        foreach (var item in new[] { MenuOpen, MenuOpenFolderAsBuild, MenuReanalyze, MenuImportFolder, MenuExport })
        {
            item.IsEnabled = !working;
        }
    }

    // ---- progress (background thread → UI) ----

    /// Bridges core progress callbacks (background thread) onto the UI thread,
    /// rate-limiting the per-chunk Progress flood to ~30 updates/s per counter.
    private sealed class UiProgressListener : ProgressListener
    {
        private readonly MainWindow _w;
        private readonly ConcurrentDictionary<ulong, long> _lastTick = new();

        public UiProgressListener(MainWindow w) => _w = w;

        public void OnBatch(ulong index, ulong total, string name) =>
            _w.Enqueue(() => _w.SetStatus($"Importing {index + 1} of {total}: {Path.GetFileName(name)}"));

        public void OnCounterOpen(ulong id, string label, string unit, double? total) =>
            _w.Enqueue(() => _w.CounterOpenUi(id, label, total));

        public void OnProgress(ulong id, double count)
        {
            var now = Environment.TickCount64;
            if (_lastTick.TryGetValue(id, out var last) && now - last < 33)
            {
                return;
            }
            _lastTick[id] = now;
            _w.Enqueue(() => _w.CounterProgressUi(id, count));
        }

        public void OnCounterClose(ulong id) => _w.Enqueue(() => _w.CounterCloseUi(id));

        public void OnMessage(string text) => _w.Enqueue(() =>
        {
            if (!_w._importing)
            {
                _w.SetStatus(text);
            }
        });
    }

    private void CounterOpenUi(ulong id, string label, double? total)
    {
        _counters.RemoveAll(c => c.Id == id);
        _counters.Add(new CounterVm { Id = id, Label = label, Total = total });
        RebuildCounters();
        if (!_importing)
        {
            SetStatus(label);
        }
    }

    private void CounterProgressUi(ulong id, double count)
    {
        var counter = _counters.FirstOrDefault(c => c.Id == id);
        if (counter == null)
        {
            return;
        }
        counter.Count = count;
        if (counter.Fraction is { } frac && _counterBars.TryGetValue(id, out var bar))
        {
            bar.Value = frac * 100;
        }
    }

    private void CounterCloseUi(ulong id)
    {
        _counters.RemoveAll(c => c.Id == id);
        RebuildCounters();
    }

    private void ClearCounters()
    {
        _counters.Clear();
        RebuildCounters();
    }

    private void RebuildCounters()
    {
        CountersPanel.Children.Clear();
        _counterBars.Clear();
        foreach (var c in _counters)
        {
            var panel = new StackPanel { Spacing = 2 };
            panel.Children.Add(new TextBlock { Text = c.Label, FontSize = 12 });
            var bar = new ProgressBar { Maximum = 100 };
            if (c.Fraction is { } frac)
            {
                bar.Value = frac * 100;
            }
            else
            {
                bar.IsIndeterminate = true;
            }
            panel.Children.Add(bar);
            CountersPanel.Children.Add(panel);
            _counterBars[c.Id] = bar;
        }
    }

    // ---- analyze / import ----

    private async void StartAnalysis(string path, bool force)
    {
        if (_working)
        {
            return;
        }
        SetWorking(true);
        _importing = false;
        var cancel = new CancelHandle();
        _cancel = cancel;
        var listener = new UiProgressListener(this);
        SetStatus($"{(force ? "Re-analyzing" : "Analyzing")} {path}…");
        try
        {
            var summary = await Task.Run(() =>
            {
                var engine = GetEngine();
                return force ? engine.Reanalyze(path, listener, cancel) : engine.Analyze(path, listener, cancel);
            });
            ShowBuild(summary);
            SetStatus($"[{(summary.FromCache ? "cached" : "analyzed")}] {summary.Sha256} — {summary.System}, {summary.FileCount} files");
        }
        catch (PrismException.Cancelled)
        {
            SetStatus("Cancelled.");
        }
        catch (Exception ex)
        {
            SetStatus("Failed.");
            await ShowErrorAsync(ErrorMessage(ex));
        }
        finally
        {
            SetWorking(false);
            _cancel = null;
            ClearCounters();
            await RefreshLibraryMetaAsync();
        }
    }

    /// Batch-import a flat list of files: analyze each, skipping any that don't
    /// parse. The library browser shows and live-updates while it runs (reads
    /// use a separate DB connection, so they never block on the import writer).
    private async void StartImport(List<string> files)
    {
        if (_working)
        {
            return;
        }
        if (files.Count == 0)
        {
            SetStatus("No files found to import.");
            return;
        }
        SetWorking(true);
        _importing = true;
        var cancel = new CancelHandle();
        _cancel = cancel;
        var listener = new UiProgressListener(this);
        SetStatus($"Importing {files.Count} files…");
        ShowLibraryPane();
        var imported = 0;
        var skipped = 0;
        var cancelled = false;
        try
        {
            await Task.Run(() => GetEngine()); // construct once, surfacing DB errors before the loop
            for (var i = 0; i < files.Count; i++)
            {
                if (cancel.IsCancelled())
                {
                    cancelled = true;
                    break;
                }
                var path = files[i];
                SetStatus($"Importing {i + 1} of {files.Count}: {Path.GetFileName(path)}");
                try
                {
                    await Task.Run(() => GetEngine().Analyze(path, listener, cancel));
                    imported++;
                    if (_libraryMode && imported % 5 == 0)
                    {
                        await RefreshLibraryAsync();
                    }
                }
                catch (PrismException.Cancelled)
                {
                    cancelled = true;
                    break;
                }
                catch (PrismException)
                {
                    skipped++; // unsupported/unreadable — skip and continue
                }
            }
            SetStatus(cancelled
                ? $"Import cancelled — {imported} imported, {skipped} skipped."
                : $"Imported {imported}, skipped {skipped} unsupported.");
        }
        catch (Exception ex)
        {
            SetStatus("Import failed.");
            await ShowErrorAsync(ErrorMessage(ex));
        }
        finally
        {
            SetWorking(false);
            _importing = false;
            _cancel = null;
            ClearCounters();
            await RefreshLibraryMetaAsync();
            if (_libraryMode)
            {
                await LoadSystemsAsync();
                await RefreshLibraryAsync();
            }
        }
    }

    /// Route opened/dropped paths: directories expand through the core's
    /// import-unit walk (a folder holding one split build stays a single unit),
    /// plain files pass through. 0 → nothing, 1 → analyze, N → batch import.
    private async Task OpenPathsAsync(List<string> paths)
    {
        if (_working)
        {
            return;
        }
        List<string> files;
        try
        {
            files = await Task.Run(() =>
            {
                var expanded = new List<string>();
                foreach (var p in paths)
                {
                    if (Directory.Exists(p))
                    {
                        expanded.AddRange(GetEngine().ListFiles(p));
                    }
                    else if (File.Exists(p))
                    {
                        expanded.Add(p);
                    }
                }
                return expanded;
            });
        }
        catch (Exception ex)
        {
            await ShowErrorAsync(ErrorMessage(ex));
            return;
        }
        switch (files.Count)
        {
            case 0:
                SetStatus("Nothing to import.");
                break;
            case 1:
                StartAnalysis(files[0], force: false);
                break;
            default:
                StartImport(files);
                break;
        }
    }

    // ---- build display ----

    private void ShowBuild(AnalysisSummary summary)
    {
        _summary = summary;
        _record = RecordDoc.Decode(summary.Json);
        _assets = summary.Assets?.ToList() ?? new List<AssetInfo>();
        _similarity = null;
        ServiceText.Text = "";
        _libraryMode = false; // opening a build leaves library mode

        var roots = summary.Tree.Select(n => new DiscNodeVm(n, isRoot: true)).ToList();
        FsTree.ItemsSource = roots;
        TreeEmptyState.Visibility = roots.Count == 0 ? Visibility.Visible : Visibility.Collapsed;

        HeaderCard.Visibility = Visibility.Visible;
        TabBar.Visibility = Visibility.Visible;
        DetailEmptyState.Visibility = Visibility.Collapsed;
        HeaderTitle.Text = summary.Title ?? summary.Name;
        HeaderTags.Children.Clear();
        HeaderTags.Children.Add(MakeBadge(summary.System, "\uE958", BadgeKind.Accent));
        HeaderTags.Children.Add(MakeBadge($"{summary.FileCount} files"));
        HeaderTags.Children.Add(MakeBadge(Format.HumanSize(summary.TotalSize)));
        if (summary.FromCache)
        {
            HeaderTags.Children.Add(MakeBadge("cached", "\uE73E", BadgeKind.Success));
        }
        HeaderSha.Text = summary.Sha256;

        BuildOverviewPanel();
        BuildSelectionPanel(null);
        BuildAssetsPanel();
        DocText.Text = "";
        DocRich.Blocks.Clear();
        _docShown = null;
        BuildSimilarPanel();
        TabBar.SelectedItem = TabOverview;
        ApplyMode();
    }

    private void ApplyMode()
    {
        BuildPane.Visibility = _libraryMode ? Visibility.Collapsed : Visibility.Visible;
        LibraryPane.Visibility = _libraryMode ? Visibility.Visible : Visibility.Collapsed;
    }

    private async void ShowLibraryPane()
    {
        _libraryMode = true;
        ApplyMode();
        await LoadSystemsAsync();
        await RefreshLibraryAsync();
    }

    // ---- tabs ----

    private void TabBar_SelectionChanged(SelectorBar sender, SelectorBarSelectionChangedEventArgs args)
    {
        var sel = sender.SelectedItem;
        OverviewScroll.Visibility = sel == TabOverview ? Visibility.Visible : Visibility.Collapsed;
        SelectionScroll.Visibility = sel == TabSelection ? Visibility.Visible : Visibility.Collapsed;
        AssetsScroll.Visibility = sel == TabAssets ? Visibility.Visible : Visibility.Collapsed;
        DocPane.Visibility = sel == TabDocument ? Visibility.Visible : Visibility.Collapsed;
        SimilarPane.Visibility = sel == TabSimilar ? Visibility.Visible : Visibility.Collapsed;
        if (sel == TabDocument)
        {
            EnsureDocText();
        }
        if (sel == TabAssets && _assets.Count > 0)
        {
            SetStatus("Click an asset to view it.");
        }
    }

    private void DocModeBar_SelectionChanged(SelectorBar sender, SelectorBarSelectionChangedEventArgs args) =>
        EnsureDocText();

    private void EnsureDocText()
    {
        if (_summary == null)
        {
            DocText.Text = "";
            DocRich.Blocks.Clear();
            _docShown = null;
            return;
        }
        var json = DocModeBar.SelectedItem == DocModeJson;
        var dark = Root.ActualTheme == ElementTheme.Dark;
        if (_docShown is { } shown && shown.Summary == _summary && shown.Json == json && shown.Dark == dark)
        {
            return; // already rendered (highlighting big docs is not free)
        }
        var text = json ? _summary.Json : _summary.Xml;
        if (DocHighlighter.TryHighlight(DocRich, text, json, dark))
        {
            DocText.Text = "";
            DocScroll.Visibility = Visibility.Visible;
            DocText.Visibility = Visibility.Collapsed;
        }
        else
        {
            DocRich.Blocks.Clear();
            DocText.Text = text;
            DocScroll.Visibility = Visibility.Collapsed;
            DocText.Visibility = Visibility.Visible;
        }
        _docShown = (_summary, json, dark);
    }

    private void DocCopy_Click(object sender, RoutedEventArgs e)
    {
        if (_summary == null)
        {
            return;
        }
        CopyToClipboard(DocModeBar.SelectedItem == DocModeJson ? _summary.Json : _summary.Xml);
        SetStatus("Copied document to clipboard.");
    }

    private void HeaderShaCopy_Click(object sender, RoutedEventArgs e)
    {
        if (_summary is { } summary)
        {
            CopyToClipboard(summary.Sha256);
            SetStatus("Copied SHA-256 to clipboard.");
        }
    }

    private void SelectTab(SelectorBarItem tab)
    {
        if (_summary != null && _libraryMode)
        {
            _libraryMode = false;
            ApplyMode();
        }
        TabBar.SelectedItem = tab;
    }

    // ---- overview / selection cards ----

    private static Brush? ThemeBrush(string key) =>
        Application.Current.Resources.TryGetValue(key, out var v) ? v as Brush : null;

    private static Style? NamedStyle(string key) =>
        Application.Current.Resources.TryGetValue(key, out var v) ? v as Style : null;

    private enum BadgeKind { Neutral, Accent, Success, Caution }

    /// Tinted pill: neutral gray for counts, accent for identity, semantic
    /// green/amber for state, so the chips carry meaning, not just text.
    private FrameworkElement MakeBadge(string text, string? glyph = null, BadgeKind kind = BadgeKind.Neutral)
    {
        var (bg, fg) = kind switch
        {
            BadgeKind.Accent => ("SystemFillColorAttentionBackgroundBrush", "AccentTextFillColorPrimaryBrush"),
            BadgeKind.Success => ("SystemFillColorSuccessBackgroundBrush", "SystemFillColorSuccessBrush"),
            BadgeKind.Caution => ("SystemFillColorCautionBackgroundBrush", "SystemFillColorCautionBrush"),
            _ => ("SubtleFillColorSecondaryBrush", "TextFillColorSecondaryBrush"),
        };
        var content = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 5,
            VerticalAlignment = VerticalAlignment.Center,
        };
        if (glyph != null)
        {
            content.Children.Add(new FontIcon
            {
                Glyph = glyph,
                FontSize = 11,
                Foreground = ThemeBrush(fg),
                VerticalAlignment = VerticalAlignment.Center,
            });
        }
        content.Children.Add(new TextBlock
        {
            Text = text,
            FontSize = 12,
            FontWeight = FontWeights.SemiBold,
            Foreground = ThemeBrush(fg),
            VerticalAlignment = VerticalAlignment.Center,
        });
        return new Border
        {
            Child = content,
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(9, 2, 9, 3),
            Background = ThemeBrush(bg),
            VerticalAlignment = VerticalAlignment.Center,
        };
    }

    private FrameworkElement SectionCard(string title, List<(string Label, string? Value, bool Mono)> rows,
        string? glyph = null)
    {
        var content = new StackPanel { Spacing = 7 };
        var head = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 8,
            Margin = new Thickness(0, 0, 0, 3),
        };
        if (glyph != null)
        {
            head.Children.Add(new FontIcon
            {
                Glyph = glyph,
                FontSize = 14,
                Foreground = ThemeBrush("AccentTextFillColorPrimaryBrush"),
                VerticalAlignment = VerticalAlignment.Center,
            });
        }
        head.Children.Add(new TextBlock
        {
            Text = title,
            Style = NamedStyle("BodyStrongTextBlockStyle"),
            VerticalAlignment = VerticalAlignment.Center,
        });
        content.Children.Add(head);
        foreach (var (label, value, mono) in rows)
        {
            if (string.IsNullOrEmpty(value))
            {
                continue;
            }
            var row = new Grid { ColumnSpacing = 12 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(170) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var key = new TextBlock { Text = label, Foreground = ThemeBrush("TextFillColorSecondaryBrush") };
            var val = new TextBlock
            {
                Text = value,
                IsTextSelectionEnabled = true,
                TextWrapping = TextWrapping.Wrap,
            };
            if (mono)
            {
                val.FontFamily = new FontFamily("Cascadia Mono,Consolas");
                val.FontSize = 12;
            }
            // Double-click a value to copy it (parity with the Win32 list view).
            val.DoubleTapped += (_, _) =>
            {
                CopyToClipboard(value);
                SetStatus("Copied value to clipboard.");
            };
            Grid.SetColumn(val, 1);
            row.Children.Add(key);
            row.Children.Add(val);
            content.Children.Add(row);
        }
        return new Border
        {
            Child = content,
            Background = ThemeBrush("CardBackgroundFillColorDefaultBrush"),
            BorderBrush = ThemeBrush("CardStrokeColorDefaultBrush"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(16, 12, 16, 14),
        };
    }

    private void AddSection(StackPanel panel, string title, List<(string, string?, bool)> rows,
        string? glyph = null)
    {
        if (rows.Any(r => !string.IsNullOrEmpty(r.Item2)))
        {
            panel.Children.Add(SectionCard(title, rows, glyph));
        }
    }

    /// Formatted build metadata, the readable counterpart to the raw DAT/XML.
    /// Renders only the fields present in the record, mirroring the macOS app.
    private void BuildOverviewPanel()
    {
        OverviewPanel.Children.Clear();
        if (_summary == null)
        {
            return;
        }
        var img = _record?.Image;
        AddSection(OverviewPanel, "Image", new List<(string, string?, bool)>
        {
            ("Name", img?.Name ?? _summary.Name, false),
            ("Size", Format.HumanSize(img?.Size ?? _summary.TotalSize), false),
            ("MD5", img?.Md5, true),
            ("SHA-1", img?.Sha1, true),
            ("SHA-256", img?.Sha256 ?? _summary.Sha256, true),
        }, "\uE7C3");
        if (_record?.Info is { } info)
        {
            AddSection(OverviewPanel, "Disc", new List<(string, string?, bool)>
            {
                ("System", info.System ?? _summary.System, false),
                ("System ID", info.SystemIdentifier, false),
                ("Disc type", info.DiscType, false),
            }, "\uE958");
            if (info.Header is { IsEmpty: false } h)
            {
                AddSection(OverviewPanel, "Header", new List<(string, string?, bool)>
                {
                    ("Title", h.Title, false),
                    ("Product number", h.ProductNumber, false),
                    ("Version", h.ProductVersion, false),
                    ("Release date", Format.PrettyDate(h.ReleaseDate), false),
                    ("Maker", h.MakerId, false),
                    ("Device", h.DeviceInfo, false),
                    ("Regions", h.Regions, false),
                }, "\uE8A5");
            }
            if (info.Sfo is { IsEmpty: false } s)
            {
                AddSection(OverviewPanel, "SFO", new List<(string, string?, bool)>
                {
                    ("Title", s.Title, false),
                    ("Disc ID", s.DiscId, false),
                    ("Disc version", s.DiscVersion, false),
                    ("Category", s.Category, false),
                    ("Parental level", s.ParentalLevel, false),
                    ("System version", s.SystemVersion, false),
                }, "\uE946");
            }
            if (info.Volume is { IsEmpty: false } v)
            {
                AddSection(OverviewPanel, "Volume", new List<(string, string?, bool)>
                {
                    ("Identifier", v.Identifier, false),
                    ("Set identifier", v.SetIdentifier, false),
                    ("Created", Format.PrettyDate(v.CreationDate), false),
                    ("Modified", Format.PrettyDate(v.ModificationDate), false),
                    ("Expires", Format.PrettyDate(v.ExpirationDate), false),
                    ("Effective", Format.PrettyDate(v.EffectiveDate), false),
                }, "\uE8B7");
            }
            if (info.Exe is { } e)
            {
                AddSection(OverviewPanel, "Boot executable", new List<(string, string?, bool)>
                {
                    ("Filename", e.Filename, false),
                    ("Date", Format.PrettyDate(e.Date), false),
                    ("Signing", e.SigningType, false),
                    ("Symbols", e.NumSymbols?.ToString(), false),
                }, "\uE756");
            }
            if (info.AltExe is { } a)
            {
                AddSection(OverviewPanel, "Alternate executable", new List<(string, string?, bool)>
                {
                    ("Filename", a.Filename, false),
                    ("Date", Format.PrettyDate(a.Date), false),
                    ("Decrypted MD5", a.Md5, true),
                }, "\uE756");
            }
        }
        if (_record?.Composites is { } c)
        {
            AddSection(OverviewPanel, "Content", new List<(string, string?, bool)>
            {
                ("Content hash", c.ContentHash, true),
                ("Filtered hash", c.FilteredContentHash, true),
                ("Boot exe hash", c.HashExe, true),
                ("Most recent file", c.MostRecentFile?.Path, false),
                ("Incomplete files", c.IncompleteFiles is > 0 ? c.IncompleteFiles.ToString() : null, false),
            }, "\uE943");
        }
        AddSection(OverviewPanel, "Structure", new List<(string, string?, bool)>
        {
            ("Files", (_record?.Structural?.FileCount ?? _summary.FileCount).ToString(), false),
            ("Total size", Format.HumanSize(_record?.Structural?.TotalSize ?? _summary.TotalSize), false),
        }, "\uE8B7");
    }

    private void BuildSelectionPanel(DiscNodeVm? vm)
    {
        SelectionPanel.Children.Clear();
        if (vm == null)
        {
            SelectionPanel.Children.Add(new TextBlock
            {
                Text = "Pick a file in the tree to see its hashes and metadata.",
                Foreground = ThemeBrush("TextFillColorSecondaryBrush"),
            });
            return;
        }
        var f = vm.Node;
        // A dir node with hashes is an archive listed as a directory: it has
        // bytes (and hashes) of its own.
        var isArchive = f.IsDir && (f.Sha1 != null || f.Sha256 != null || f.Md5 != null);
        SelectionPanel.Children.Add(SectionCard(f.Name, new List<(string, string?, bool)>
        {
            ("Type", f.IsDir ? (isArchive ? "Archive" : "Directory") : "File", false),
            ("Size", !f.IsDir || isArchive ? Format.HumanSize(f.Size) : null, false),
            ("Date", f.Date, false),
            ("Status", f.Unreadable ? "Unreadable (bad dump)" : null, false),
            ("MD5", f.Md5, true),
            ("SHA-1", f.Sha1, true),
            ("SHA-256", f.Sha256, true),
        }, vm.Glyph));
    }

    private void FsTree_ItemInvoked(TreeView sender, TreeViewItemInvokedEventArgs args)
    {
        if (args.InvokedItem is DiscNodeVm vm && !vm.Node.IsDir)
        {
            BuildSelectionPanel(vm);
            SelectTab(TabSelection);
        }
        else if (args.InvokedItem is DiscNodeVm dir)
        {
            BuildSelectionPanel(dir);
        }
    }

    // ---- assets ----

    private static readonly string[] AssetKindOrder = { "image", "audio", "video", "document", "source", "text", "binary" };

    private static string AssetKindTitle(string kind) => kind switch
    {
        "source" => "Source code",
        "binary" => "Unidentified",
        _ => char.ToUpperInvariant(kind[0]) + kind[1..],
    };

    private static string AssetKindGlyph(string kind) => kind switch
    {
        "image" => "\uE91B",
        "audio" => "\uE8D6",
        "video" => "\uE714",
        "document" => "\uE8A5",
        "source" => "\uE943",
        "binary" => "\uE9D9",
        _ => "\uE7C3",
    };

    private void BuildAssetsPanel()
    {
        AssetsPanel.Children.Clear();
        if (_summary == null)
        {
            return;
        }
        if (_summary.Assets == null)
        {
            AssetsPanel.Children.Add(new TextBlock
            {
                Text = "Asset extraction hasn't run for this build yet — re-analyze the image to extract viewable files.",
                Foreground = ThemeBrush("TextFillColorSecondaryBrush"),
                TextWrapping = TextWrapping.Wrap,
            });
            return;
        }
        if (_assets.Count == 0)
        {
            AssetsPanel.Children.Add(new TextBlock
            {
                Text = "This build carries no extractable assets.",
                Foreground = ThemeBrush("TextFillColorSecondaryBrush"),
            });
            return;
        }
        foreach (var kind in AssetKindOrder)
        {
            var group = _assets.Where(a => a.Kind == kind).ToList();
            if (group.Count == 0)
            {
                continue;
            }
            var header = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Spacing = 8,
                Margin = new Thickness(2, 10, 0, 4),
            };
            header.Children.Add(new FontIcon
            {
                Glyph = AssetKindGlyph(kind),
                FontSize = 14,
                Foreground = ThemeBrush("AccentTextFillColorPrimaryBrush"),
                VerticalAlignment = VerticalAlignment.Center,
            });
            header.Children.Add(new TextBlock
            {
                Text = AssetKindTitle(kind),
                Style = NamedStyle("BodyStrongTextBlockStyle"),
                VerticalAlignment = VerticalAlignment.Center,
            });
            header.Children.Add(MakeBadge(group.Count.ToString()));
            AssetsPanel.Children.Add(header);
            if (kind == "image")
            {
                var grid = new VariableSizedWrapGrid
                {
                    Orientation = Orientation.Horizontal,
                    ItemWidth = 164,
                    ItemHeight = 158,
                };
                foreach (var asset in group)
                {
                    grid.Children.Add(MakeThumbTile(asset));
                }
                AssetsPanel.Children.Add(grid);
            }
            else
            {
                AssetsPanel.Children.Add(MakeRowCard(group.Select(MakeAssetRow)));
            }
        }
    }

    /// Settings-style group card: rows separated by hairlines inside one
    /// rounded surface, instead of loose buttons floating on the page.
    private FrameworkElement MakeRowCard(IEnumerable<UIElement> rows)
    {
        var list = new StackPanel();
        var first = true;
        foreach (var row in rows)
        {
            if (!first)
            {
                list.Children.Add(new Border
                {
                    Height = 1,
                    Background = ThemeBrush("DividerStrokeColorDefaultBrush"),
                    Margin = new Thickness(40, 0, 0, 0),
                });
            }
            first = false;
            list.Children.Add(row);
        }
        return new Border
        {
            Child = list,
            Background = ThemeBrush("CardBackgroundFillColorDefaultBrush"),
            BorderBrush = ThemeBrush("CardStrokeColorDefaultBrush"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(4),
        };
    }

    private UIElement MakeThumbTile(AssetInfo asset)
    {
        // Gallery look: the image fills a rounded rect (center-cropped), with
        // a subtle placeholder behind it until (or unless) the decode lands.
        var brush = new ImageBrush { Stretch = Stretch.UniformToFill };
        var thumb = new Grid { Height = 106 };
        thumb.Children.Add(new Border
        {
            CornerRadius = new CornerRadius(6),
            Background = ThemeBrush("ControlFillColorSecondaryBrush"),
        });
        thumb.Children.Add(new FontIcon
        {
            Glyph = "\uE91B",
            FontSize = 20,
            Foreground = ThemeBrush("TextFillColorTertiaryBrush"),
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
        });
        thumb.Children.Add(new Microsoft.UI.Xaml.Shapes.Rectangle
        {
            RadiusX = 6,
            RadiusY = 6,
            Fill = brush,
        });
        var name = new TextBlock
        {
            Text = Format.LastComponent(asset.Path),
            FontSize = 11,
            TextTrimming = TextTrimming.CharacterEllipsis,
            HorizontalAlignment = HorizontalAlignment.Center,
        };
        var panel = new Grid { RowSpacing = 5 };
        panel.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        panel.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        panel.Children.Add(thumb);
        Grid.SetRow(name, 1);
        panel.Children.Add(name);
        var button = new Button
        {
            Content = panel,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            VerticalAlignment = VerticalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            VerticalContentAlignment = VerticalAlignment.Stretch,
            Margin = new Thickness(0, 0, 8, 8),
            Padding = new Thickness(5),
        };
        ToolTipService.SetToolTip(button, asset.Path);
        button.Click += (_, _) => OpenAsset(asset);
        button.ContextFlyout = MakeAssetMenu(asset);
        LoadThumb(brush, asset);
        return button;
    }

    private UIElement MakeAssetRow(AssetInfo asset)
    {
        var row = new Grid { ColumnSpacing = 10 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var icon = new FontIcon
        {
            Glyph = AssetKindGlyph(asset.Kind),
            FontSize = 14,
            Foreground = ThemeBrush("TextFillColorSecondaryBrush"),
            VerticalAlignment = VerticalAlignment.Center,
        };
        row.Children.Add(icon);

        var names = new StackPanel { Spacing = 1 };
        names.Children.Add(new TextBlock
        {
            Text = Format.LastComponent(asset.Path),
            TextTrimming = TextTrimming.CharacterEllipsis,
        });
        names.Children.Add(new TextBlock
        {
            Text = asset.Path,
            FontSize = 11,
            Foreground = ThemeBrush("TextFillColorSecondaryBrush"),
            TextTrimming = TextTrimming.CharacterEllipsis,
        });
        Grid.SetColumn(names, 1);
        row.Children.Add(names);

        var col = 2;
        if (asset.BlobPath == null)
        {
            var tag = MakeBadge("not local", null, BadgeKind.Caution);
            Grid.SetColumn(tag, col);
            row.Children.Add(tag);
        }
        col++;
        var size = new TextBlock
        {
            Text = Format.HumanSize(asset.Size),
            FontSize = 12,
            Foreground = ThemeBrush("TextFillColorSecondaryBrush"),
            VerticalAlignment = VerticalAlignment.Center,
        };
        Grid.SetColumn(size, col++);
        row.Children.Add(size);
        var mime = new TextBlock
        {
            Text = asset.Mime,
            FontSize = 12,
            Foreground = ThemeBrush("TextFillColorTertiaryBrush"),
            VerticalAlignment = VerticalAlignment.Center,
        };
        Grid.SetColumn(mime, col);
        row.Children.Add(mime);

        var button = new Button
        {
            Content = row,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            BorderThickness = new Thickness(0),
            Padding = new Thickness(8, 6, 8, 6),
        };
        button.Click += (_, _) => OpenAsset(asset);
        button.ContextFlyout = MakeAssetMenu(asset);
        return button;
    }

    private MenuFlyout MakeAssetMenu(AssetInfo asset)
    {
        var menu = new MenuFlyout();
        var view = new MenuFlyoutItem
        {
            Text = asset.Kind is "text" or "source" or "binary" ? "Preview" : "View",
        };
        view.Click += (_, _) => OpenAsset(asset);
        menu.Items.Add(view);
        if (asset.Kind is not ("text" or "source" or "binary"))
        {
            // Never shell-open text/source/binary: handing a `.bat`/`.js` from an
            // untrusted disc to the default verb could execute it.
            var external = new MenuFlyoutItem { Text = "Open Externally", IsEnabled = asset.BlobPath != null };
            external.Click += (_, _) => OpenExternally(asset);
            menu.Items.Add(external);
        }
        var copy = new MenuFlyoutItem { Text = "Copy SHA-256" };
        copy.Click += (_, _) =>
        {
            CopyToClipboard(asset.Sha256);
            SetStatus("Copied SHA-256 to clipboard.");
        };
        menu.Items.Add(copy);
        return menu;
    }

    private async void LoadThumb(ImageBrush target, AssetInfo asset)
    {
        if (asset.BlobPath == null)
        {
            return;
        }
        try
        {
            var bytes = await Task.Run(() =>
            {
                var raw = File.ReadAllBytes(asset.BlobPath);
                return asset.Mime == "image/x-tga" ? NativeMethods.TgaToBmp(raw) ?? raw : raw;
            });
            var bmp = new BitmapImage { DecodePixelWidth = 220 };
            using var stream = new InMemoryRandomAccessStream();
            await stream.WriteAsync(bytes.AsBuffer());
            stream.Seek(0);
            await bmp.SetSourceAsync(stream);
            target.ImageSource = bmp;
        }
        catch
        {
            // Undecodable image: the placeholder tile stays, opening still works.
        }
    }

    // ---- asset viewer ----

    /// View one extracted asset. Text/source preview in-app only (never handed
    /// to the shell), binary previews as a hex dump, images and audio/video get
    /// the in-app viewer, documents (PDF) go to the default app via a staged
    /// temp copy carrying the original filename.
    private async void OpenAsset(AssetInfo asset)
    {
        if (asset.BlobPath == null)
        {
            SetStatus("Asset not in the local store — re-analyze the image to extract it.");
            return;
        }
        switch (asset.Kind)
        {
            case "binary":
                await ShowHexPreviewAsync(asset);
                break;
            case "text":
            case "source":
                await ShowTextPreviewAsync(asset);
                break;
            case "image":
                await ShowImagePreviewAsync(asset);
                break;
            case "audio":
            case "video":
                await ShowMediaPreviewAsync(asset);
                break;
            default:
                OpenExternally(asset);
                break;
        }
    }

    private void OpenExternally(AssetInfo asset)
    {
        if (asset.BlobPath == null)
        {
            SetStatus("Asset not in the local store — re-analyze the image to extract it.");
            return;
        }
        try
        {
            var staged = asset.Mime == "image/x-tga"
                ? AssetStaging.MaterializeTga(asset, asset.BlobPath)
                : AssetStaging.Materialize(asset, asset.BlobPath);
            Process.Start(new ProcessStartInfo(staged) { UseShellExecute = true });
            SetStatus($"Opened {asset.Path}.");
        }
        catch (Exception ex)
        {
            SetStatus($"Couldn't open asset: {ex.Message}");
        }
    }

    /// The analyzer stores only the first 2 KB of an unidentified file, so a blob
    /// this long is (almost surely) a truncated head.
    private const int SnippetBytes = 2048;

    private const int TextPreviewCap = 256 * 1024;

    private async Task ShowTextPreviewAsync(AssetInfo asset)
    {
        try
        {
            var (text, truncated) = await Task.Run(() =>
            {
                using var f = File.OpenRead(asset.BlobPath!);
                var buf = new byte[Math.Min(f.Length, TextPreviewCap)];
                f.ReadExactly(buf);
                var s = System.Text.Encoding.UTF8.GetString(buf)
                    .Replace("\0", "").Replace("\r\n", "\n");
                return (s, (long)asset.Size > TextPreviewCap);
            });
            ShowPreview(asset, MakeTextPreviewControl(text.Length == 0 ? "(empty file)" : text),
                truncated ? "Preview truncated to the first 256 KB." : null, text);
        }
        catch (Exception ex)
        {
            SetStatus($"Couldn't read asset from the local store: {ex.Message}");
        }
    }

    private async Task ShowHexPreviewAsync(AssetInfo asset)
    {
        try
        {
            var dump = await Task.Run(() => Format.HexDump(File.ReadAllBytes(asset.BlobPath!)));
            ShowPreview(asset, MakeTextPreviewControl(dump),
                (long)asset.Size >= SnippetBytes ? "Unidentified file — only its first 2 KB is stored." : null,
                dump);
        }
        catch (Exception ex)
        {
            SetStatus($"Couldn't read asset from the local store: {ex.Message}");
        }
    }

    private async Task ShowImagePreviewAsync(AssetInfo asset)
    {
        try
        {
            var bytes = await Task.Run(() =>
            {
                var raw = File.ReadAllBytes(asset.BlobPath!);
                return asset.Mime == "image/x-tga" ? NativeMethods.TgaToBmp(raw) ?? raw : raw;
            });
            var bmp = new BitmapImage();
            using (var stream = new InMemoryRandomAccessStream())
            {
                await stream.WriteAsync(bytes.AsBuffer());
                stream.Seek(0);
                await bmp.SetSourceAsync(stream);
            }
            var img = new Image { Source = bmp, Stretch = Stretch.Uniform };
            ShowPreview(asset, img, $"{Format.HumanSize(asset.Size)} · {asset.Mime}", null);
        }
        catch (Exception ex)
        {
            SetStatus($"Couldn't decode image: {ex.Message}");
        }
    }

    private async Task ShowMediaPreviewAsync(AssetInfo asset)
    {
        try
        {
            var stream = File.OpenRead(asset.BlobPath!);
            var media = new MediaPlayerElement
            {
                AreTransportControlsEnabled = true,
                AutoPlay = true,
                MinHeight = asset.Kind == "video" ? 320 : 80,
            };
            media.Source = MediaSource.CreateFromStream(stream.AsRandomAccessStream(), asset.Mime);
            _activeMedia = media;
            media.MediaPlayer.MediaFailed += (_, _) => Enqueue(() =>
            {
                ClosePreview();
                SetStatus("Playback failed — opening externally.");
                OpenExternally(asset);
            });
            ShowPreview(asset, media, $"{Format.HumanSize(asset.Size)} · {asset.Mime}", null);
        }
        catch (Exception ex)
        {
            SetStatus($"Couldn't open media: {ex.Message}");
        }
    }

    private UIElement MakeTextPreviewControl(string text)
    {
        var block = new TextBlock
        {
            Text = text,
            FontFamily = new FontFamily("Cascadia Mono,Consolas"),
            FontSize = 12,
            IsTextSelectionEnabled = true,
        };
        return new ScrollViewer
        {
            Content = block,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            Padding = new Thickness(8),
        };
    }

    private void ShowPreview(AssetInfo asset, UIElement content, string? note, string? copyText)
    {
        _previewAsset = asset;
        _previewText = copyText;
        PreviewTitle.Text = Format.LastComponent(asset.Path);
        PreviewNote.Text = note ?? "";
        PreviewHost.Children.Clear();
        PreviewHost.Children.Add(content);
        // Text/source/binary are never shell-opened (see MakeAssetMenu).
        PreviewOpenExternalBtn.Visibility = asset.Kind is "text" or "source" or "binary"
            ? Visibility.Collapsed
            : Visibility.Visible;
        PreviewOverlay.Visibility = Visibility.Visible;
    }

    private void ClosePreview()
    {
        if (_activeMedia != null)
        {
            try
            {
                (_activeMedia.Source as MediaSource)?.Dispose();
                _activeMedia.Source = null;
                _activeMedia.MediaPlayer?.Dispose();
            }
            catch
            {
                // best-effort teardown
            }
            _activeMedia = null;
        }
        PreviewHost.Children.Clear();
        PreviewOverlay.Visibility = Visibility.Collapsed;
        _previewAsset = null;
        _previewText = null;
    }

    private void PreviewClose_Click(object sender, RoutedEventArgs e) => ClosePreview();

    private void PreviewCopy_Click(object sender, RoutedEventArgs e)
    {
        var text = _previewText ?? _previewAsset?.Sha256;
        if (!string.IsNullOrEmpty(text))
        {
            CopyToClipboard(text);
            SetStatus(_previewText != null ? "Copied preview text to clipboard." : "Copied SHA-256 to clipboard.");
        }
    }

    private void PreviewOpenExternal_Click(object sender, RoutedEventArgs e)
    {
        if (_previewAsset is { } asset)
        {
            ClosePreview();
            OpenExternally(asset);
        }
    }

    // ---- library ----

    private async Task InitializeLibraryAsync()
    {
        try
        {
            var (count, recent, systems) = await Task.Run(() =>
            {
                var engine = GetEngine();
                return (engine.LibrarySize(), engine.RecentBuilds(15), engine.LibrarySystems());
            });
            LibCountText.Text = $"library: {count}";
            _librarySystems = systems.ToList();
            RefreshRecentMenu(recent);
            PopulateSystemsCombo();
        }
        catch (Exception ex)
        {
            SetStatus($"Library unavailable: {ErrorMessage(ex)}");
        }
    }

    private async Task RefreshLibraryMetaAsync()
    {
        try
        {
            var (count, recent) = await Task.Run(() =>
            {
                var engine = GetEngine();
                return (engine.LibrarySize(), engine.RecentBuilds(15));
            });
            LibCountText.Text = $"library: {count}";
            RefreshRecentMenu(recent);
        }
        catch
        {
            // library metadata is decorative; ignore failures here
        }
    }

    private void RefreshRecentMenu(LibraryEntry[] recent)
    {
        RecentSubmenu.Items.Clear();
        if (recent.Length == 0)
        {
            RecentSubmenu.Items.Add(new MenuFlyoutItem { Text = "(none yet)", IsEnabled = false });
            return;
        }
        foreach (var entry in recent)
        {
            var item = new MenuFlyoutItem { Text = $"{entry.Name} — {entry.System}" };
            var sha = entry.Sha256;
            item.Click += (_, _) => OpenSha(sha);
            RecentSubmenu.Items.Add(item);
        }
    }

    private async Task LoadSystemsAsync()
    {
        try
        {
            _librarySystems = (await Task.Run(() => GetEngine().LibrarySystems())).ToList();
            PopulateSystemsCombo();
        }
        catch
        {
            // filter combo keeps its previous content
        }
    }

    private void PopulateSystemsCombo()
    {
        var keep = SystemFilter.SelectedIndex;
        SystemFilter.Items.Clear();
        SystemFilter.Items.Add("All systems");
        foreach (var s in _librarySystems)
        {
            SystemFilter.Items.Add(s);
        }
        SystemFilter.SelectedIndex = keep >= 0 && keep < SystemFilter.Items.Count ? keep : 0;
    }

    private async Task RefreshLibraryAsync()
    {
        var q = SearchBox.Text.Trim();
        var idx = SystemFilter.SelectedIndex;
        var system = idx <= 0 ? null : _librarySystems.ElementAtOrDefault(idx - 1);
        var sort = _librarySort;
        var desc = _librarySortDesc;
        try
        {
            var rows = await Task.Run(() =>
                GetEngine().SearchLibrary(q.Length == 0 ? null : q, system, sort, desc, 10_000, 0));
            LibraryList.ItemsSource = rows.Select(r => new LibraryRowVm(r)).ToList();
            LibCountFooter.Text = $"{rows.Length} build{(rows.Length == 1 ? "" : "s")}";
        }
        catch
        {
            // stale results stay visible; the next refresh retries
        }
    }

    /// Column headers above the library list; click sorts, same column flips.
    private void BuildLibraryHeader()
    {
        var widths = new (LibrarySort Sort, string Title, double Width, bool Stretch)[]
        {
            (LibrarySort.Name, "Title", 0, true),
            (LibrarySort.System, "System", 130, false),
            (LibrarySort.Files, "Files", 64, false),
            (LibrarySort.Size, "Size", 88, false),
            (LibrarySort.Date, "Analyzed", 120, false),
        };
        LibraryHeaderGrid.ColumnSpacing = 12;
        for (var i = 0; i < widths.Length; i++)
        {
            var (sort, title, width, stretch) = widths[i];
            LibraryHeaderGrid.ColumnDefinitions.Add(new ColumnDefinition
            {
                Width = stretch ? new GridLength(1, GridUnitType.Star) : new GridLength(width),
            });
            var label = new TextBlock { Text = title, FontSize = 12, FontWeight = FontWeights.SemiBold };
            var icon = new FontIcon { Glyph = "\uE70D", FontSize = 8, Visibility = Visibility.Collapsed };
            var content = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
            content.Children.Add(label);
            content.Children.Add(icon);
            var button = new Button
            {
                Content = content,
                Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                BorderThickness = new Thickness(0),
                Padding = new Thickness(2, 2, 2, 2),
                HorizontalAlignment = stretch ? HorizontalAlignment.Left : HorizontalAlignment.Right,
            };
            button.Click += (_, _) => SortLibraryBy(sort);
            Grid.SetColumn(button, i);
            LibraryHeaderGrid.Children.Add(button);
            _libHeaders[sort] = (button, icon);
        }
        UpdateSortIndicators();
    }

    /// Same column flips direction; a new column resets to a sensible default
    /// (text ascending, counts/dates descending).
    private async void SortLibraryBy(LibrarySort column)
    {
        if (_librarySort == column)
        {
            _librarySortDesc = !_librarySortDesc;
        }
        else
        {
            _librarySort = column;
            _librarySortDesc = column is not (LibrarySort.Name or LibrarySort.System);
        }
        UpdateSortIndicators();
        await RefreshLibraryAsync();
    }

    private void UpdateSortIndicators()
    {
        foreach (var (sort, (_, icon)) in _libHeaders)
        {
            icon.Visibility = sort == _librarySort ? Visibility.Visible : Visibility.Collapsed;
            icon.Glyph = _librarySortDesc ? "\uE70D" : "\uE70E";
        }
    }

    private async void SearchBox_TextChanged(AutoSuggestBox sender, AutoSuggestBoxTextChangedEventArgs args) =>
        await RefreshLibraryAsync();

    private async void SystemFilter_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (LibraryPane.Visibility == Visibility.Visible)
        {
            await RefreshLibraryAsync();
        }
    }

    private void LibraryList_ItemClick(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is LibraryRowVm row)
        {
            OpenSha(row.Entry.Sha256);
        }
    }

    /// Load a stored build from cache by sha256 and display it (no re-analysis).
    /// Uses the reader connection, so it works mid-import.
    private async void OpenSha(string sha)
    {
        try
        {
            var summary = await Task.Run(() => GetEngine().LoadBuild(sha));
            if (summary == null)
            {
                SetStatus("Build not in cache anymore.");
                return;
            }
            ShowBuild(summary);
            if (!_working)
            {
                SetStatus($"Loaded from cache — {summary.System}, {summary.FileCount} files, {Format.HumanSize(summary.TotalSize)}.");
            }
        }
        catch (Exception ex)
        {
            SetStatus("Failed.");
            await ShowErrorAsync(ErrorMessage(ex));
        }
    }

    // ---- web service: similarity + submit ----

    private void SetQuerying(bool querying)
    {
        _isQuerying = querying;
        QueryRing.IsActive = querying;
        BusyRing.IsActive = _working || querying;
        FindSimilarBtn.IsEnabled = !querying;
        SubmitBtn.IsEnabled = !querying;
    }

    private async void FindSimilar()
    {
        if (_summary == null)
        {
            SetStatus("Analyze a build first.");
            return;
        }
        if (_isQuerying)
        {
            return;
        }
        SelectTab(TabSimilar);
        SetQuerying(true);
        _similarity = null;
        ServiceText.Text = $"Querying {_service.BaseUrl.Host}…";
        try
        {
            _similarity = await _service.FindSimilarAsync(_summary.Json);
            ServiceText.Text = _similarity.IsEmpty
                ? "No similar builds found."
                : $"Neighbors across {_similarity.Sections.Count} tier(s).";
        }
        catch (Exception ex)
        {
            ServiceText.Text = ex.Message;
        }
        finally
        {
            SetQuerying(false);
            BuildSimilarPanel();
        }
    }

    private void BuildSimilarPanel()
    {
        SimilarPanel.Children.Clear();
        if (_similarity == null || _similarity.IsEmpty)
        {
            SimilarPanel.Children.Add(new TextBlock
            {
                Text = "Query the web service for builds that share content, files, chunks, audio, executables, or descriptions.",
                Foreground = ThemeBrush("TextFillColorSecondaryBrush"),
                TextWrapping = TextWrapping.Wrap,
            });
            return;
        }
        foreach (var (title, neighbors) in _similarity.Sections)
        {
            var header = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Spacing = 8,
                Margin = new Thickness(2, 8, 0, 4),
            };
            header.Children.Add(new TextBlock
            {
                Text = title,
                Style = NamedStyle("BodyStrongTextBlockStyle"),
                VerticalAlignment = VerticalAlignment.Center,
            });
            header.Children.Add(MakeBadge(neighbors.Count.ToString()));
            SimilarPanel.Children.Add(header);
            SimilarPanel.Children.Add(MakeRowCard(neighbors.Select(MakeNeighborRow)));
        }
    }

    private UIElement MakeNeighborRow(SimilarNeighbor neighbor)
    {
        var row = new Grid { ColumnSpacing = 10 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var names = new StackPanel { Spacing = 1 };
        names.Children.Add(new TextBlock
        {
            Text = neighbor.Name ?? neighbor.Sha256,
            TextTrimming = TextTrimming.CharacterEllipsis,
        });
        names.Children.Add(new TextBlock
        {
            Text = neighbor.Sha256,
            FontFamily = new FontFamily("Cascadia Mono,Consolas"),
            FontSize = 11,
            Foreground = ThemeBrush("TextFillColorSecondaryBrush"),
            TextTrimming = TextTrimming.CharacterEllipsis,
        });
        row.Children.Add(names);

        if (neighbor.System is { } system)
        {
            var tag = MakeBadge(system, null, BadgeKind.Accent);
            Grid.SetColumn(tag, 1);
            row.Children.Add(tag);
        }
        if (neighbor.ScoreText is { } score)
        {
            var scoreBlock = new TextBlock
            {
                Text = score,
                FontFamily = new FontFamily("Cascadia Mono,Consolas"),
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
                Foreground = ThemeBrush("AccentTextFillColorPrimaryBrush"),
                VerticalAlignment = VerticalAlignment.Center,
            };
            Grid.SetColumn(scoreBlock, 2);
            row.Children.Add(scoreBlock);
        }

        var button = new Button
        {
            Content = row,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            BorderThickness = new Thickness(0),
            Padding = new Thickness(8, 5, 8, 5),
        };
        ToolTipService.SetToolTip(button, $"Open {neighbor.Sha256} in the web library");
        button.Click += (_, _) => OpenInWeb(neighbor.Sha256);
        var menu = new MenuFlyout();
        var open = new MenuFlyoutItem { Text = "Open in Web" };
        open.Click += (_, _) => OpenInWeb(neighbor.Sha256);
        menu.Items.Add(open);
        var copy = new MenuFlyoutItem { Text = "Copy SHA-256" };
        copy.Click += (_, _) => CopyToClipboard(neighbor.Sha256);
        menu.Items.Add(copy);
        button.ContextFlyout = menu;
        return button;
    }

    private void OpenInWeb(string sha256)
    {
        try
        {
            Process.Start(new ProcessStartInfo(_service.BuildPage(sha256).ToString()) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            SetStatus($"Couldn't open browser: {ex.Message}");
        }
    }

    /// Submit the loaded build to the moderation queue, then upload whichever
    /// of its asset blobs the server reports missing; with a moderation token,
    /// accept it so it replaces the live build.
    private async void SubmitBuild()
    {
        if (_summary == null)
        {
            SetStatus("Analyze a build first.");
            return;
        }
        if (_isQuerying)
        {
            return;
        }
        var nickname = await PromptNicknameAsync();
        if (string.IsNullOrWhiteSpace(nickname))
        {
            return;
        }
        SetQuerying(true);
        ServiceText.Text = "Submitting…";
        var summary = _summary;
        try
        {
            var result = await _service.SubmitAsync(summary.Json, nickname.Trim());
            var assetNote = await UploadMissingAssetsAsync(summary);
            var acceptNote = "";
            if (_service.ModerationToken != null)
            {
                try
                {
                    await _service.AcceptAsync(summary.Sha256);
                    acceptNote = " Accepted — live build updated.";
                }
                catch (Exception ex)
                {
                    acceptNote = $" Accept failed: {ex.Message}";
                }
            }
            var shortSha = result.Sha256.Length > 12 ? result.Sha256[..12] : result.Sha256;
            ServiceText.Text = $"Submitted {shortSha}… — {result.Status}.{assetNote}{acceptNote}";
        }
        catch (Exception ex)
        {
            ServiceText.Text = ex.Message;
        }
        finally
        {
            SetQuerying(false);
        }
    }

    /// How many asset blobs to upload at once. Each is its own resumable PUT,
    /// so chunks of one blob never interleave.
    private const int ParallelUploads = 32;

    private async Task<string> UploadMissingAssetsAsync(AnalysisSummary summary)
    {
        var local = new Dictionary<string, string>();
        foreach (var a in _assets)
        {
            if (a.BlobPath != null)
            {
                local[a.Sha256] = a.BlobPath;
            }
        }
        if (local.Count == 0)
        {
            return ""; // nothing extracted locally, nothing to offer
        }
        try
        {
            var missing = await _service.MissingAssetsAsync(summary.Sha256);
            if (missing.Count == 0)
            {
                return " Assets already on server.";
            }
            var todo = missing.Where(local.ContainsKey).ToList();
            var unavailable = missing.Count - todo.Count;
            var done = 0;
            var failed = 0;
            string? firstError = null;
            using var gate = new SemaphoreSlim(ParallelUploads);
            var tasks = todo.Select(async sha =>
            {
                await gate.WaitAsync();
                try
                {
                    await _service.UploadAssetAsync(summary.Sha256, sha, local[sha]);
                    Interlocked.Increment(ref done);
                }
                catch (Exception ex)
                {
                    Interlocked.Increment(ref failed);
                    firstError ??= ex.Message;
                }
                finally
                {
                    gate.Release();
                    Enqueue(() => ServiceText.Text = $"Uploading assets {done + failed}/{todo.Count}…");
                }
            }).ToList();
            await Task.WhenAll(tasks);
            var note = $" Uploaded {done} asset blob{(done == 1 ? "" : "s")}";
            if (failed > 0)
            {
                note += $", {failed} failed: {firstError}";
            }
            if (unavailable > 0)
            {
                note += $" ({unavailable} not in the local store)";
            }
            return note + ".";
        }
        catch (Exception ex)
        {
            return $" Asset upload failed: {ex.Message}";
        }
    }

    // ---- dialogs ----

    /// Adapter failures are often long multi-line tracebacks; a dialog with
    /// selectable text plus a Copy button lets the user grab the message.
    private async Task ShowErrorAsync(string message)
    {
        var text = new TextBlock
        {
            Text = message,
            FontFamily = new FontFamily("Cascadia Mono,Consolas"),
            FontSize = 12,
            IsTextSelectionEnabled = true,
            TextWrapping = TextWrapping.Wrap,
        };
        var dialog = new ContentDialog
        {
            Title = "Analysis failed",
            Content = new ScrollViewer { Content = text, MaxHeight = 380 },
            PrimaryButtonText = "Copy",
            CloseButtonText = "Close",
            DefaultButton = ContentDialogButton.Close,
            XamlRoot = Content.XamlRoot,
        };
        dialog.PrimaryButtonClick += (_, e) =>
        {
            CopyToClipboard(message);
            e.Cancel = true; // keep the dialog open after copying
        };
        await dialog.ShowAsync();
    }

    private async Task<string?> PromptNicknameAsync()
    {
        var box = new TextBox { PlaceholderText = "Nickname" };
        var panel = new StackPanel { Spacing = 10 };
        panel.Children.Add(new TextBlock
        {
            Text = "Adds this build to the moderation queue. A nickname is attached for attribution.",
            TextWrapping = TextWrapping.Wrap,
            Foreground = ThemeBrush("TextFillColorSecondaryBrush"),
        });
        panel.Children.Add(box);
        var dialog = new ContentDialog
        {
            Title = "Submit build",
            Content = panel,
            PrimaryButtonText = "Submit",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Primary,
            XamlRoot = Content.XamlRoot,
        };
        var result = await dialog.ShowAsync();
        return result == ContentDialogResult.Primary ? box.Text : null;
    }

    private static void CopyToClipboard(string text)
    {
        var package = new DataPackage();
        package.SetText(text);
        Clipboard.SetContent(package);
    }

    // ---- pickers ----

    private void InitPicker(object picker) =>
        WinRT.Interop.InitializeWithWindow.Initialize(picker,
            WinRT.Interop.WindowNative.GetWindowHandle(this));

    private async Task<string?> PickFileAsync()
    {
        var picker = new FileOpenPicker();
        InitPicker(picker);
        foreach (var ext in new[] { ".bin", ".iso", ".cue", ".img", ".chd", ".zip", ".7z", ".rar" })
        {
            picker.FileTypeFilter.Add(ext);
        }
        picker.FileTypeFilter.Add("*");
        var file = await picker.PickSingleFileAsync();
        return file?.Path;
    }

    private async Task<string?> PickFolderAsync()
    {
        var picker = new FolderPicker();
        InitPicker(picker);
        picker.FileTypeFilter.Add("*");
        var folder = await picker.PickSingleFolderAsync();
        return folder?.Path;
    }

    // ---- menu handlers ----

    private async void MenuOpen_Click(object sender, RoutedEventArgs e)
    {
        if (_working)
        {
            return;
        }
        if (await PickFileAsync() is { } path)
        {
            StartAnalysis(path, force: false);
        }
    }

    private async void MenuReanalyze_Click(object sender, RoutedEventArgs e)
    {
        // Full re-parse and re-hash, replacing the library record, for dumps
        // whose earlier parse is known bad (plain re-analyze is a cache hit).
        if (_working)
        {
            return;
        }
        if (await PickFileAsync() is { } path)
        {
            StartAnalysis(path, force: true);
        }
    }

    private async void MenuOpenFolderAsBuild_Click(object sender, RoutedEventArgs e)
    {
        // Force the whole folder through as ONE build (a split multi-track
        // dump), regardless of the single-build heuristic.
        if (_working)
        {
            return;
        }
        if (await PickFolderAsync() is { } dir)
        {
            StartAnalysis(dir, force: false);
        }
    }

    private async void MenuImportFolder_Click(object sender, RoutedEventArgs e)
    {
        if (_working)
        {
            return;
        }
        if (await PickFolderAsync() is { } dir)
        {
            await OpenPathsAsync(new List<string> { dir });
        }
    }

    private void MenuBrowseLibrary_Click(object sender, RoutedEventArgs e) => ShowLibraryPane();

    private async void MenuExport_Click(object sender, RoutedEventArgs e)
    {
        if (_working)
        {
            SetStatus("Busy — wait for the current analysis to finish.");
            return;
        }
        var picker = new FileSavePicker { SuggestedFileName = "collection.prism" };
        InitPicker(picker);
        picker.FileTypeChoices.Add("Prism bundle", new List<string> { ".zip" });
        var file = await picker.PickSaveFileAsync();
        if (file == null)
        {
            return;
        }
        SetWorking(true);
        SetStatus("Exporting library…");
        try
        {
            var count = await Task.Run(() => GetEngine().ExportBundle(file.Path));
            SetStatus(count == 0
                ? "Library is empty — analyze a disc first."
                : $"Exported {count} builds → {file.Path}");
        }
        catch (Exception ex)
        {
            SetStatus("Export failed.");
            await ShowErrorAsync(ErrorMessage(ex));
        }
        finally
        {
            SetWorking(false);
        }
    }

    private void MenuExit_Click(object sender, RoutedEventArgs e) => Close();

    private void MenuCancel_Click(object sender, RoutedEventArgs e)
    {
        _cancel?.Cancel();
        SetStatus("Cancelling…");
    }

    private void MenuSimilar_Click(object sender, RoutedEventArgs e) => FindSimilar();

    private void MenuSubmit_Click(object sender, RoutedEventArgs e) => SubmitBuild();

    private void MenuViewOverview_Click(object sender, RoutedEventArgs e) => SelectTab(TabOverview);

    private void MenuViewAssets_Click(object sender, RoutedEventArgs e) => SelectTab(TabAssets);

    private void MenuViewDocument_Click(object sender, RoutedEventArgs e) => SelectTab(TabDocument);

    private void MenuViewSimilar_Click(object sender, RoutedEventArgs e) => SelectTab(TabSimilar);

    // ---- drag and drop ----

    private void Root_DragOver(object sender, DragEventArgs e)
    {
        e.AcceptedOperation = !_working && e.DataView.Contains(StandardDataFormats.StorageItems)
            ? DataPackageOperation.Copy
            : DataPackageOperation.None;
    }

    private async void Root_Drop(object sender, DragEventArgs e)
    {
        if (_working || !e.DataView.Contains(StandardDataFormats.StorageItems))
        {
            return;
        }
        var items = await e.DataView.GetStorageItemsAsync();
        var paths = items.Select(i => i.Path).Where(p => !string.IsNullOrEmpty(p)).ToList();
        if (paths.Count > 0)
        {
            await OpenPathsAsync(paths);
        }
    }
}
