"""PyInstaller entry point: freeze the prism adapter CLI into one binary."""

from prism_adapter.cli import main

if __name__ == "__main__":
    main()
