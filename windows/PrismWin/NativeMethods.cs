using System.Runtime.InteropServices;
using System.Text;

namespace PrismWin;

/// P/Invoke surface: the plain C exports of prism_ffi.dll (outside the UniFFI
/// bindings) and the kernel32 console-attach calls used by `--cli` mode.
internal static class NativeMethods
{
    // ---- prism_ffi plain C exports ----

    [DllImport("prism_ffi", CallingConvention = CallingConvention.Cdecl)]
    [return: MarshalAs(UnmanagedType.I1)]
    private static extern bool prism_tga_to_bmp(IntPtr data, nuint len, out IntPtr outPtr, out nuint outLen);

    [DllImport("prism_ffi", CallingConvention = CallingConvention.Cdecl)]
    private static extern void prism_buffer_free(IntPtr ptr, nuint len);

    [DllImport("prism_ffi", CallingConvention = CallingConvention.Cdecl)]
    private static extern int prism_cli_run(nuint argc, IntPtr argv, IntPtr adapterBin);

    /// Convert a TGA image to a 32bpp BMP via the core decoder. Null when the
    /// bytes don't decode as TGA.
    public static byte[]? TgaToBmp(byte[] tga)
    {
        var pin = GCHandle.Alloc(tga, GCHandleType.Pinned);
        try
        {
            if (!prism_tga_to_bmp(pin.AddrOfPinnedObject(), (nuint)tga.Length, out var ptr, out var len))
            {
                return null;
            }
            var bmp = new byte[(int)len];
            Marshal.Copy(ptr, bmp, 0, (int)len);
            prism_buffer_free(ptr, len);
            return bmp;
        }
        finally
        {
            pin.Free();
        }
    }

    /// Run the shared prism CLI in-process (the caller attaches a console first).
    public static int CliRun(IReadOnlyList<string> args, string? adapterBin)
    {
        var strings = new IntPtr[args.Count];
        var argvPin = default(GCHandle);
        var adapterPtr = IntPtr.Zero;
        try
        {
            for (var i = 0; i < args.Count; i++)
            {
                strings[i] = Utf8(args[i]);
            }
            if (adapterBin != null)
            {
                adapterPtr = Utf8(adapterBin);
            }
            argvPin = GCHandle.Alloc(strings, GCHandleType.Pinned);
            return prism_cli_run((nuint)args.Count, argvPin.AddrOfPinnedObject(), adapterPtr);
        }
        finally
        {
            if (argvPin.IsAllocated)
            {
                argvPin.Free();
            }
            foreach (var p in strings)
            {
                if (p != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(p);
                }
            }
            if (adapterPtr != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(adapterPtr);
            }
        }
    }

    private static IntPtr Utf8(string s)
    {
        var bytes = Encoding.UTF8.GetBytes(s + "\0");
        var ptr = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, ptr, bytes.Length);
        return ptr;
    }

    // ---- console attach for --cli ----

    private const uint AttachParentProcess = 0xFFFFFFFF;
    private const int StdInput = -10;
    private const int StdOutput = -11;
    private const int StdError = -12;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AllocConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetStdHandle(int nStdHandle, IntPtr hHandle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(
        string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes,
        uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    /// A GUI-subsystem exe starts detached with NULL std handles, so adopt the
    /// launching console (or create one when started outside any), then point
    /// still-unset std handles at it. Handles the parent redirected (`> file`,
    /// pipes) are inherited as-is and stay untouched.
    public static void AttachOrAllocConsole()
    {
        if (!AttachConsole(AttachParentProcess) && !AllocConsole())
        {
            return; // headless; std writes will fail silently
        }
        const uint genericRead = 0x80000000;
        const uint genericWrite = 0x40000000;
        const uint shareReadWrite = 0x3;
        const uint openExisting = 3;
        foreach (var (slot, device) in new[] { (StdInput, "CONIN$"), (StdOutput, "CONOUT$"), (StdError, "CONOUT$") })
        {
            var current = GetStdHandle(slot);
            if (current == IntPtr.Zero || current == new IntPtr(-1))
            {
                var handle = CreateFileW(device, genericRead | genericWrite, shareReadWrite,
                    IntPtr.Zero, openExisting, 0, IntPtr.Zero);
                if (handle != new IntPtr(-1))
                {
                    SetStdHandle(slot, handle); // deliberately leaked: a std handle lives for the process
                }
            }
        }
    }
}
