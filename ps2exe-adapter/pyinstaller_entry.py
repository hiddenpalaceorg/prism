"""PyInstaller entry point: freeze the curator adapter CLI into one binary."""

from curator_adapter.cli import main

if __name__ == "__main__":
    main()
