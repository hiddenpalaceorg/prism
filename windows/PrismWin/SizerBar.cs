using Microsoft.UI.Input;
using Microsoft.UI.Xaml.Controls;

namespace PrismWin;

/// Hit strip between resizable panes showing the east-west resize cursor.
/// ProtectedCursor is only settable from inside a UIElement subclass, hence
/// this class; the drag logic lives with the owner of the sized column.
public sealed partial class SizerBar : Border
{
    public SizerBar()
    {
        ProtectedCursor = InputSystemCursor.Create(InputSystemCursorShape.SizeWestEast);
    }
}
