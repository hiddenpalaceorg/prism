namespace PrismWin;

/// `PrismWin --cli <command…>`: attach to the launching console and run the
/// shared prism CLI in-process. The exe is a GUI-subsystem binary, so an
/// interactive prompt returns immediately; output still lands in the console,
/// and redirection (`> file`, pipes) behaves normally.
internal static class CliMode
{
    public static int Run(string[] args)
    {
        NativeMethods.AttachOrAllocConsole();
        var argv = new List<string> { Environment.ProcessPath ?? "prism" };
        argv.AddRange(args.Skip(1)); // drop the "--cli" marker
        return NativeMethods.CliRun(argv, AdapterLocator.BundledAdapter());
    }
}

/// Resolves the Python analysis adapter, mirroring prism-win: env override →
/// bundle next to the exe → env dir → the dev `ps2exe-adapter` uv project.
internal static class AdapterLocator
{
    /// The adapter bundled next to the exe (`adapter\prism-adapter*`), if present.
    /// Used directly by the GUI and as the CLI's fallback when no flag or env
    /// var picks an adapter.
    public static string? BundledAdapter()
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "adapter");
        foreach (var name in new[] { "prism-adapter.exe", "prism-adapter.cmd", "prism-adapter.bat", "prism-adapter" })
        {
            var p = Path.Combine(dir, name);
            if (File.Exists(p))
            {
                return p;
            }
        }
        return null;
    }

    /// (adapterDir, adapterBin) for Engine construction; exactly one is non-null.
    public static (string? Dir, string? Bin) Resolve()
    {
        var envBin = Environment.GetEnvironmentVariable("PRISM_ADAPTER_BIN");
        if (!string.IsNullOrEmpty(envBin))
        {
            return (null, envBin);
        }
        var bundled = BundledAdapter();
        if (bundled != null)
        {
            return (null, bundled);
        }
        var envDir = Environment.GetEnvironmentVariable("PRISM_ADAPTER_DIR");
        return (string.IsNullOrEmpty(envDir) ? "ps2exe-adapter" : envDir, null);
    }
}
