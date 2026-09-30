#!/usr/bin/env python3
"""Check launcher argv without starting a GUI or accessing a user's files."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class NativeDocumentLauncherTest(unittest.TestCase):
    def test_headless_browser_preserves_cli_arguments_without_desktop_session_flags(self):
        directory_root = Path(__file__).resolve().parents[1] / "docker"
        with tempfile.TemporaryDirectory(prefix="headless-route-test-") as directory:
            root = Path(directory)
            chrome = root / "google-chrome"
            chrome.write_text("#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n")
            chrome.chmod(0o700)
            launcher = root / "openteam-screen-launch"
            launcher.write_bytes((directory_root / "openteam-screen-launch").read_bytes())
            launcher.chmod(0o700)
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ["PATH"],
                       OPENTEAM_BROWSER_PROFILE=str(root / "desktop profile"), OPENTEAM_BROWSER_DEBUG_PORT="9444")
            for headless in ("--headless", "--headless=new"):
                for extra in ([], ["--user-data-dir=" + str(root / "explicit profile")]):
                    args = [headless, *extra, "--dump-dom", "file:///workspace/report 日本語.html"]
                    for command in (["sh", str(launcher), "chromium"],
                                    ["sh", str(directory_root / "openteam-browser")]):
                        with self.subTest(args=args, command=command):
                            result = subprocess.run([*command, *args], env=env, text=True, capture_output=True, timeout=5)
                            self.assertEqual(result.returncode, 0, result.stderr)
                            self.assertEqual(json.loads(result.stdout), ["--no-sandbox", "--disable-dev-shm-usage", *args])

    def test_browser_routes_preserve_urls_and_profile(self):
        directory_root = Path(__file__).resolve().parents[1] / "docker"
        with tempfile.TemporaryDirectory(prefix="browser-route-test-") as directory:
            root = Path(directory)
            chrome = root / "google-chrome"
            chrome.write_text("#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n")
            chrome.chmod(0o700)
            launcher = root / "openteam-screen-launch"
            launcher.write_bytes((directory_root / "openteam-screen-launch").read_bytes())
            launcher.chmod(0o700)
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ["PATH"],
                       OPENTEAM_BROWSER_PROFILE=str(root / "screen profile"), OPENTEAM_BROWSER_DEBUG_PORT="9444")
            for urls in ([], ["https://example.com/a?q=one&v=two"],
                         ["file:///workspace/report 日本語.html", "https://example.com/second"],
                         ["https://example.com/quote'$(literal)"]):
                for command in (["sh", str(launcher), "chromium"],
                                ["sh", str(directory_root / "openteam-browser")]):
                    with self.subTest(urls=urls, command=command):
                        result = subprocess.run([*command, *urls], env=env, text=True, capture_output=True, timeout=5)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        args = json.loads(result.stdout)
                        self.assertIn("--user-data-dir=" + str(root / "screen profile"), args)
                        self.assertIn("--remote-debugging-port=9444", args)
                        self.assertEqual(args[args.index("--new-window") + 1:], urls or ["about:blank"])

    def test_editor_preserves_file_arguments(self):
        launcher = Path(__file__).resolve().parents[1] / "docker/openteam-screen-launch"
        with tempfile.TemporaryDirectory(prefix="editor-launcher-test-") as directory:
            root = Path(directory)
            executable = root / "mousepad"
            executable.write_text(
                "#!/usr/bin/env python3\n"
                "import json, sys\n"
                "print(json.dumps(sys.argv[1:]))\n"
            )
            executable.chmod(0o700)
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ["PATH"])
            for files in (
                [],
                ["/workspace/notes.txt"],
                ["/workspace/meeting notes 日本語.txt"],
                ["/workspace/first.txt", "/workspace/second.txt"],
                ["/workspace/quote'name;$(literal).txt"],
            ):
                with self.subTest(files=files):
                    result = subprocess.run(
                        ["sh", str(launcher), "editor", *files],
                        env=env, text=True, capture_output=True, timeout=5,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout), ["--disable-server", *files])

    def test_preserves_documents_and_isolated_profile(self):
        launcher = Path(__file__).resolve().parents[1] / "docker/openteam-screen-launch"
        with tempfile.TemporaryDirectory(prefix="screen-launcher-test-") as directory:
            root = Path(directory)
            executable = root / "libreoffice"
            executable.write_text(
                "#!/usr/bin/env python3\n"
                "import json, sys\n"
                "print(json.dumps(sys.argv[1:]))\n"
            )
            executable.chmod(0o700)
            browser_profile = root / "isolated profile"
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ["PATH"])
            env["OPENTEAM_BROWSER_PROFILE"] = str(browser_profile)
            for kind in ("writer", "calc", "impress", "draw"):
                for documents in (
                    [],
                    ["/workspace/annual report α.docx"],
                    ["/workspace/first file.odp", "/workspace/second résumé.odp"],
                    ["/workspace/quote'name;$(literal).odp"],
                ):
                    with self.subTest(application=kind, documents=documents):
                        result = subprocess.run(
                            ["sh", str(launcher), kind, *documents],
                            env=env, text=True, capture_output=True, timeout=5,
                        )
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual(json.loads(result.stdout), [
                            "-env:UserInstallation=" + Path(str(browser_profile) + "-office").as_uri(),
                            "--" + kind,
                            *documents,
                        ])


if __name__ == "__main__":
    unittest.main()
