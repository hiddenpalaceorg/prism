using Microsoft.UI.Input;
using Microsoft.UI.Xaml.Controls;

namespace PrismWin;

/// Hit strip between resizable panes showing the east-west resize cursor.
/// ProtectedCursor is only settable from inside a UIElement subclass, hence
/// this class (a Panel because Border is sealed in the WinRT projection);
/// the drag logic lives with the owner of the sized column.
public sealed partial class SizerBar : Panel
{
    public SizerBar()
    {
        ProtectedCursor = InputSystemCursor.Create(InputSystemCursorShape.SizeWestEast);
    }
}
