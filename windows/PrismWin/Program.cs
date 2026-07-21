// Custom entry point (DISABLE_XAML_GENERATED_MAIN): `PrismWin --cli <command…>`
// runs the shared prism CLI in-process instead of opening a window, mirroring
// prism-win's dual GUI/CLI behavior.

namespace PrismWin;

public static class Program
{
    [global::System.STAThread]
    static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--cli")
        {
            return CliMode.Run(args);
        }
        // A GUI app that dies before its window shows dies silently; leave a trace.
        global::System.AppDomain.CurrentDomain.UnhandledException +=
            (_, e) => LogCrash(e.ExceptionObject as global::System.Exception, "appdomain");
        global::System.Threading.Tasks.TaskScheduler.UnobservedTaskException +=
            (_, e) => LogCrash(e.Exception, "task");
        global::WinRT.ComWrappersSupport.InitializeComWrappers();
        global::Microsoft.UI.Xaml.Application.Start(p =>
        {
            var context = new global::Microsoft.UI.Dispatching.DispatcherQueueSynchronizationContext(
                global::Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread());
            global::System.Threading.SynchronizationContext.SetSynchronizationContext(context);
            _ = new App();
        });
        return 0;
    }

    /// Append a crash record to prismwin-crash.log next to the exe (or in TEMP
    /// when the install dir is read-only). Best-effort by design.
    public static void LogCrash(global::System.Exception? ex, string source)
    {
        var stamp = global::System.DateTime.Now.ToString("O");
        var line = $"[{stamp}] {source}: {ex}\r\n";
        foreach (var dir in new[] { global::System.AppContext.BaseDirectory, global::System.IO.Path.GetTempPath() })
        {
            try
            {
                global::System.IO.File.AppendAllText(
                    global::System.IO.Path.Combine(dir, "prismwin-crash.log"), line);
                return;
            }
            catch
            {
                // try the next location
            }
        }
    }
}
