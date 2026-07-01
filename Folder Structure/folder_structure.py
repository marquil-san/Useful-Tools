import os

# Skip folders that contain more than this many files
MAX_FILES = 20


def print_tree(path, prefix=""):
    try:
        entries = sorted(os.listdir(path), key=lambda x: (not os.path.isdir(os.path.join(path, x)), x.lower()))
    except PermissionError:
        print(prefix + "[Permission Denied]")
        return

    files = [
        e for e in entries
        if os.path.isfile(os.path.join(path, e))
    ]

    if len(files) > MAX_FILES:
        print(prefix + f"[Skipped: {len(files)} files]")
        return

    total = len(entries)

    for i, entry in enumerate(entries):
        full_path = os.path.join(path, entry)
        connector = "└── " if i == total - 1 else "├── "

        if os.path.isdir(full_path):
            print(prefix + connector + f"📁 {entry}")

            extension = "    " if i == total - 1 else "│   "
            print_tree(full_path, prefix + extension)
        else:
            print(prefix + connector + f"📄 {entry}")


def main():
    path = input("Enter folder path: ").strip().strip('"')

    if not os.path.isdir(path):
        print("Invalid folder path.")
        return

    print(f"\n📁 {os.path.basename(path) or path}")
    print_tree(path)


if __name__ == "__main__":
    main()