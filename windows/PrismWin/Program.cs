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
}
