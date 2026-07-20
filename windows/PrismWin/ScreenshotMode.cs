using Microsoft.UI.Xaml.Media.Imaging;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace PrismWin;

/// CI-only hook: when PRISM_SHOT_DIR is set, render the main views to PNGs in
/// that directory and exit, so design changes are reviewable from workflow
/// artifacts without a Windows machine. PRISM_SHOT_OPEN optionally names a
/// path to analyze first, populating the views with a real build.
public sealed partial class MainWindow
{
    private void MaybeStartScreenshotRun()
    {
        if (Environment.GetEnvironmentVariable("PRISM_SHOT_DIR") is { Length: > 0 } dir)
        {
            _ = RunScreenshotScriptAsync(dir);
        }
    }

    private async Task RunScreenshotScriptAsync(string dir)
    {
        try
        {
            Directory.CreateDirectory(dir);
            // Captures see only the XAML tree, not the composition backdrop;
            // paint the base color in so shots approximate the Mica look.
            Root.Background = ThemeBrush("SolidBackgroundFillColorBaseBrush");
            await Task.Delay(2000);
            if (Environment.GetEnvironmentVariable("PRISM_SHOT_OPEN") is { Length: > 0 } open)
            {
                StartAnalysis(open, force: false);
                for (var waited = 0; (_working || _summary == null) && waited < 120_000; waited += 500)
                {
                    await Task.Delay(500);
                }
                await Task.Delay(1000);
                if (_summary == null)
                {
                    File.WriteAllText(Path.Combine(dir, "error.txt"),
                        $"status: {StatusText.Text}\nlast error: {_lastError ?? "(none)"}\n");
                }
            }
            await CaptureAsync(dir, "1-overview.png");
            if (_summary != null)
            {
                TabBar.SelectedItem = TabAssets;
                await Task.Delay(1500);
                await CaptureAsync(dir, "2-assets.png");
                TabBar.SelectedItem = TabDocument;
                await Task.Delay(1500);
                await CaptureAsync(dir, "3-dat.png");
            }
            ShowLibraryPane();
            await Task.Delay(1500);
            await CaptureAsync(dir, "4-library.png");
        }
        catch (Exception ex)
        {
            Program.LogCrash(ex, "screenshots");
        }
        finally
        {
            Environment.Exit(0);
        }
    }

    private async Task CaptureAsync(string dir, string name)
    {
        var bitmap = new RenderTargetBitmap();
        await bitmap.RenderAsync(Root);
        var pixels = (await bitmap.GetPixelsAsync()).ToArray();
        using var stream = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream);
        encoder.SetPixelData(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied,
            (uint)bitmap.PixelWidth, (uint)bitmap.PixelHeight, 96, 96, pixels);
        await encoder.FlushAsync();
        stream.Seek(0);
        using var file = File.Create(Path.Combine(dir, name));
        await stream.AsStreamForRead().CopyToAsync(file);
    }
}
