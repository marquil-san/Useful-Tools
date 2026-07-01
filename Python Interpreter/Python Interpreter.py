import sys
import os
import re
import keyword
import builtins
import tokenize
from io import StringIO
import jedi
from PySide6.QtWidgets import QStyle
from PySide6.QtWidgets import QInputDialog

from PySide6.QtWidgets import (
    QApplication, QWidget, QVBoxLayout, QPushButton, QHBoxLayout,
    QListWidget, QFileDialog, QLabel, QPlainTextEdit, QTextEdit, QCompleter
)
from PySide6.QtCore import QProcess, QRect, QSize, Qt, QStringListModel
from PySide6.QtGui import (
    QTextCursor, QFont, QSyntaxHighlighter, QTextCharFormat,
    QColor, QPainter
)


# =========================
# 🎨 Syntax Highlighter
# =========================
class PythonHighlighter(QSyntaxHighlighter):
    def __init__(self, document):
        super().__init__(document)
        self.IN_MULTILINE_STRING = 1

        def fmt(color, bold=False, italic=False):
            f = QTextCharFormat()
            f.setForeground(QColor(color))
            if bold:
                f.setFontWeight(QFont.Bold)
            if italic:
                f.setFontItalic(True)
            return f

        self.styles = {
            "keyword": fmt("#ff7b72", True),
            "builtin": fmt("#00ffff"),
            "string": fmt("#a5d6ff"),
            "comment": fmt("#8b949e", italic=True),
            "number": fmt("#79c0ff"),
            "operator": fmt("#ff9d00"),
            "function": fmt("#ffd700"),
            "defname": fmt("#d2a8ff", True),
            "normal": fmt("#c9d1d9"),
        }

        self.keywords = set(keyword.kwlist)
        self.builtins = set(dir(builtins))

    def highlightBlock(self, text):
        self.setFormat(0, len(text), self.styles["normal"])

        in_multiline = self.previousBlockState() == self.IN_MULTILINE_STRING
        triple_single = "'''"
        triple_double = '"""'
        start = 0

        # multiline handling
        if in_multiline:
            end = text.find(triple_single)
            end2 = text.find(triple_double)

            if end == -1 and end2 == -1:
                self.setFormat(0, len(text), self.styles["string"])
                self.setCurrentBlockState(self.IN_MULTILINE_STRING)
                return
            else:
                end_positions = [i for i in [end, end2] if i != -1]
                end = min(end_positions)
                self.setFormat(0, end + 3, self.styles["string"])
                start = end + 3
                self.setCurrentBlockState(0)

        while True:
            i1 = text.find(triple_single, start)
            i2 = text.find(triple_double, start)
            i_list = [i for i in [i1, i2] if i != -1]
            if not i_list:
                break

            i = min(i_list)
            end = text.find(text[i:i + 3], i + 3)

            if end == -1:
                self.setFormat(i, len(text) - i, self.styles["string"])
                self.setCurrentBlockState(self.IN_MULTILINE_STRING)
                return
            else:
                self.setFormat(i, end + 3 - i, self.styles["string"])
                start = end + 3

        try:
            tokens = list(tokenize.generate_tokens(StringIO(text).readline))
        except tokenize.TokenError:
            return

        prev_token = None

        for tok_type, tok_string, start_pos, end_pos, _ in tokens:
            s = start_pos[1]
            l = end_pos[1] - start_pos[1]

            if tok_type == tokenize.COMMENT:
                self.setFormat(s, l, self.styles["comment"])

            elif tok_type == tokenize.STRING:
                self.setFormat(s, l, self.styles["string"])

            elif tok_type == tokenize.NUMBER:
                self.setFormat(s, l, self.styles["number"])

            elif tok_type == tokenize.NAME:
                if tok_string in self.keywords:
                    self.setFormat(s, l, self.styles["keyword"])

                elif tok_string in self.builtins:
                    # ✅ FIX: builtins always cyan
                    self.setFormat(s, l, self.styles["builtin"])

                elif prev_token and prev_token[1] == "def":
                    self.setFormat(s, l, self.styles["defname"])

                else:
                    # only user functions
                    if end_pos[1] < len(text) and text[end_pos[1]] == "(":
                        self.setFormat(s, l, self.styles["function"])

            elif tok_type == tokenize.OP:
                self.setFormat(s, l, self.styles["operator"])

            prev_token = (tok_type, tok_string)


# =========================
# 📏 Line Numbers Area
# =========================
class LineNumberArea(QWidget):
    def __init__(self, editor):
        super().__init__(editor)
        self.editor = editor

    def sizeHint(self):
        return QSize(self.editor.line_number_area_width(), 0)

    def paintEvent(self, event):
        self.editor.line_number_area_paint_event(event)


from PySide6.QtWidgets import QStyledItemDelegate
from PySide6.QtGui import QPainter, QColor, QFont
from PySide6.QtCore import Qt

from PySide6.QtWidgets import QStyledItemDelegate, QStyle
from PySide6.QtGui import QPainter, QColor, QFont


class CompletionDelegate(QStyledItemDelegate):
    def __init__(self, completer):
        super().__init__()
        self.completer = completer

    def paint(self, painter, option, index):
        painter.save()

        text = index.data()
        prefix = self.completer.completionPrefix().lower()

        # 🎨 background
        if option.state & QStyle.State_Selected:
            painter.fillRect(option.rect, QColor("#21262d"))
        else:
            painter.fillRect(option.rect, QColor("#161b22"))

        normal_color = QColor("#c9d1d9")
        match_color = QColor("#58a6ff")

        painter.setFont(QFont("Consolas", 11))

        x = option.rect.x() + 8
        fm = painter.fontMetrics()
        y = option.rect.y() + (option.rect.height() + fm.ascent() - fm.descent()) // 2

        painter.setPen(normal_color)

        # 🔥 FUZZY MATCH LOGIC
        match_indexes = []
        j = 0

        for i, ch in enumerate(text.lower()):
            if j < len(prefix) and ch == prefix[j]:
                match_indexes.append(i)
                j += 1

        # draw character-by-character
        for i, ch in enumerate(text):
            if i in match_indexes:
                painter.setPen(match_color)
            else:
                painter.setPen(normal_color)

            painter.drawText(x, y, ch)
            x += painter.fontMetrics().horizontalAdvance(ch)

        painter.restore()


# =========================
# ✨ Code Editor (WITH JEDI)
# =========================
class CodeEditor(QPlainTextEdit):
    def __init__(self):
        super().__init__()
        self.setFont(QFont("Consolas", 14))
        self.setStyleSheet("background:#0d1117;color:#c9d1d9;padding-left:5px;")

        # 🔥 autocomplete
        self.completer = QCompleter()
        self.completer.setWidget(self)
        self.completer.setCompletionMode(QCompleter.PopupCompletion)
        self.completer.setCaseSensitivity(Qt.CaseInsensitive)
        self.completer.activated.connect(self.insert_completion)

        popup = self.completer.popup()
        popup.setItemDelegate(CompletionDelegate(self.completer))

        self.setStyleSheet("""
        QPlainTextEdit {
            background-color: #0d1117;
            color: #c9d1d9;
            padding-left: 5px;
            selection-background-color: #30363d;
            selection-color: #ffffff;
        }
        """)

        popup.setStyleSheet("""

        QListView {
            background-color: #161b22;
            color: #c9d1d9;
            border: 1px solid #30363d;
            padding: 2px;
            outline: 0;
        }

        QListView::item {
            padding: 1px 8px;   /* 🔥 smaller height */
            border-radius: 4px;
        }

        QListView::item:selected {
            background-color: #21262d;
            color: #c9d1d9;
        }

        QListView::item:hover {
            background-color: #30363d;
        }
        """)

        popup.setFont(QFont("Consolas", 11))
        popup.setUniformItemSizes(True)
        popup.setMaximumHeight(200)

        self.base_words = list(set(keyword.kwlist + dir(builtins)))

        # line numbers
        self.line_number_area = LineNumberArea(self)

        self.blockCountChanged.connect(self.update_line_number_area_width)
        self.updateRequest.connect(self.update_line_number_area)
        self.cursorPositionChanged.connect(self.highlight_current_line)

        self.update_line_number_area_width(0)
        self.highlight_current_line()

    # =========================
    # 🧠 Jedi autocomplete
    # =========================
    def get_completions(self):
        code = self.toPlainText()
        cursor = self.textCursor()
        line = cursor.blockNumber() + 1
        column = cursor.positionInBlock()

        cursor.select(QTextCursor.WordUnderCursor)
        word = cursor.selectedText()

        try:
            script = jedi.Script(code)
            completions = script.complete(line, column)

            names = []
            for c in completions:
                name = c.name

                # filter private unless typing _
                if not word.startswith("_") and name.startswith("_"):
                    continue

                names.append(name)

            # 🔥 SMART SORTING
            def score(n):
                if n.startswith(word):
                    return (0, len(n))  # best match
                elif word in n:
                    return (1, len(n))
                else:
                    return (2, len(n))

            names = sorted(set(names), key=score)

            return names

        except:
            return []

    def insert_completion(self, completion):
        cursor = self.textCursor()
        cursor.select(QTextCursor.WordUnderCursor)
        cursor.removeSelectedText()

        # 🔥 functions that should auto-add ()
        auto_bracket = False

        # builtins like print, range, input
        if completion in self.base_words:
            try:
                obj = getattr(builtins, completion, None)
                if callable(obj):
                    auto_bracket = True
            except:
                pass

        # also handle user-defined functions (basic check)
        if completion not in keyword.kwlist and completion not in self.base_words:
            auto_bracket = True

        if auto_bracket:
            cursor.insertText(completion + "()")
            cursor.movePosition(QTextCursor.Left)  # move inside ()
        else:
            cursor.insertText(completion)

        self.setTextCursor(cursor)

    # =========================
    # ⚡ key handling (MERGED)
    # =========================
    def keyPressEvent(self, event):
        # ✅ 1. accept autocomplete FIRST
        if self.completer.popup().isVisible():
            if event.key() in (Qt.Key_Return, Qt.Key_Enter):
                self.completer.activated.emit(
                    self.completer.currentCompletion()
                )
                self.completer.popup().hide()
                return

        # 🔥 2. smart auto-indent
        if event.key() in (Qt.Key_Return, Qt.Key_Enter):
            cursor = self.textCursor()
            cursor.select(QTextCursor.LineUnderCursor)
            line = cursor.selectedText()

            indent = len(line) - len(line.lstrip(' '))
            stripped = line.strip()

            super().keyPressEvent(event)

            # increase indent after :
            if stripped.endswith(":"):
                indent += 4

            text = event.text()

            if text in pairs:
                cursor = self.textCursor()

                # insert pair
                cursor.insertText(text + pairs[text])

                # move cursor back inside
                cursor.movePosition(QTextCursor.Left)
                self.setTextCursor(cursor)
                return

            # skip closing if already present
            if text in pairs.values():
                cursor = self.textCursor()
                next_char = self.document().characterAt(cursor.position())

                if next_char == text:
                    cursor.movePosition(QTextCursor.Right)
                    self.setTextCursor(cursor)
                    return

            # optional dedent
            dedent_keywords = ("return", "pass", "break", "continue", "raise")
            if stripped.startswith(dedent_keywords):
                indent = max(0, indent - 4)

            self.insertPlainText(" " * indent)
            return

            # optional: auto-dedent for certain keywords
            dedent_keywords = ("return", "pass", "break", "continue", "raise")
            if stripped.startswith(dedent_keywords):
                indent = max(0, indent - 4)

            self.insertPlainText(" " * indent)
            return

        # keep auto-indent
        if event.key() == 16777220:
            cursor = self.textCursor()
            cursor.select(QTextCursor.LineUnderCursor)
            line = cursor.selectedText()
            indent = len(line) - len(line.lstrip(' '))
            super().keyPressEvent(event)
            self.insertPlainText(' ' * indent)
            return

        super().keyPressEvent(event)
        # 🔥 AUTO-CLOSE BRACKETS
        pairs = {
            "(": ")",
            "[": "]",
            "{": "}",
            '"': '"',
            "'": "'",
        }

        cursor = self.textCursor()
        cursor.select(QTextCursor.WordUnderCursor)
        word = cursor.selectedText()

        text = self.toPlainText()

        # 🧠 smarter trigger rules
        trigger = False

        if event.text() == ".":
            trigger = True  # ALWAYS trigger on dot

        elif len(word) >= 2:
            trigger = True  # only after 2+ chars

        if not trigger:
            self.completer.popup().hide()
            return

        # 🔥 GET SUGGESTIONS
        suggestions = self.get_completions()

        if not suggestions and word:
            suggestions = [w for w in self.base_words if w.startswith(word)]

        # ❌ nothing to show
        if not suggestions:
            self.completer.popup().hide()
            return

        # ✅ show suggestions
        model = QStringListModel(suggestions)
        self.completer.setModel(model)
        self.completer.setCompletionPrefix(word)

        popup = self.completer.popup()
        popup.setCurrentIndex(model.index(0, 0))

        rect = self.cursorRect()
        rect.setWidth(popup.sizeHintForColumn(0) + 20)
        self.completer.complete(rect)

    # =========================
    # (UNCHANGED editor stuff)
    # =========================
    def line_number_area_width(self):
        digits = len(str(max(1, self.blockCount())))
        return 10 + self.fontMetrics().horizontalAdvance('9') * digits

    def update_line_number_area_width(self, _):
        self.setViewportMargins(self.line_number_area_width(), 0, 0, 0)

    def update_line_number_area(self, rect, dy):
        if dy:
            self.line_number_area.scroll(0, dy)
        else:
            self.line_number_area.update(0, rect.y(), self.line_number_area.width(), rect.height())

    def resizeEvent(self, event):
        super().resizeEvent(event)
        cr = self.contentsRect()
        self.line_number_area.setGeometry(QRect(cr.left(), cr.top(), self.line_number_area_width(), cr.height()))

    def line_number_area_paint_event(self, event):
        painter = QPainter(self.line_number_area)
        painter.fillRect(event.rect(), QColor("#0d1117"))

        block = self.firstVisibleBlock()
        block_number = block.blockNumber()
        top = int(self.blockBoundingGeometry(block).translated(self.contentOffset()).top())
        bottom = top + int(self.blockBoundingRect(block).height())

        while block.isValid() and top <= event.rect().bottom():
            if block.isVisible():
                number = str(block_number + 1)
                painter.setPen(QColor("#8b949e"))
                painter.drawText(0, top, self.line_number_area.width() - 5,
                                 self.fontMetrics().height(), Qt.AlignRight, number)

            block = block.next()
            top = bottom
            bottom = top + int(self.blockBoundingRect(block).height())
            block_number += 1

    def highlight_current_line(self):
        extra = []
        if not self.isReadOnly():
            selection = QTextEdit.ExtraSelection()
            selection.format.setBackground(QColor("#161b22"))
            selection.format.setProperty(QTextCharFormat.FullWidthSelection, True)
            selection.cursor = self.textCursor()
            selection.cursor.clearSelection()
            extra.append(selection)
        self.setExtraSelections(extra)


# =========================
# 🖥 Terminal
# =========================
import re
from PySide6.QtGui import QTextCharFormat, QColor


class TerminalWidget(QPlainTextEdit):
    ANSI_REGEX = re.compile(r'\x1b\[(\d+)m')

    COLOR_MAP = {
        30: "#000000",  # black
        31: "#ff5f56",  # red
        32: "#27c93f",  # green
        33: "#f1fa8c",  # yellow
        34: "#58a6ff",  # blue
        35: "#bc8cff",  # magenta
        36: "#39c5cf",  # cyan
        37: "#f0f6fc",  # white
    }

    def __init__(self, process, parent=None):
        super().__init__(parent)
        self.process = process

        # 🔥 better terminal theme
        self.setStyleSheet("""
        QPlainTextEdit {
            background-color: #0d1117;
            color: #f0f6fc;
            padding: 10px;
            font-family: Consolas;
            font-size: 13px;
        }
        """)

        self.current_color = QColor("#f0f6fc")

    def append_ansi_text(self, text):
        cursor = self.textCursor()

        parts = self.ANSI_REGEX.split(text)

        i = 0
        while i < len(parts):
            if i % 2 == 0:
                # normal text
                fmt = QTextCharFormat()
                fmt.setForeground(self.current_color)
                cursor.insertText(parts[i], fmt)
            else:
                code = int(parts[i])

                if code == 0:
                    self.current_color = QColor("#f0f6fc")
                elif code in self.COLOR_MAP:
                    self.current_color = QColor(self.COLOR_MAP[code])

            i += 1

        self.setTextCursor(cursor)
        self.moveCursor(QTextCursor.End)

    def keyPressEvent(self, event):
        if self.process.state() == QProcess.Running:
            text = event.text()
            try:
                if event.key() == 16777220:
                    self.process.write(b"\n")
                    self.append_ansi_text("\n")
                    return
                elif event.key() == 16777219:
                    self.process.write(b"\x7f")
                    self.textCursor().deletePreviousChar()
                    return
                if text:
                    self.process.write(text.encode())
                    self.append_ansi_text(text)
                    return
            except:
                return
        super().keyPressEvent(event)


# =========================
# 🧠 IDE (UNCHANGED)
# =========================
class IDE(QWidget):

    def install_package(self):
        cmd, ok = QInputDialog.getText(
            self,
            "Package Installer",
            "Enter command:",
            text=""
        )

        if not ok or not cmd.strip():
            return

        self.terminal.clear()
        self.terminal.show()

        parts = cmd.strip().split()

        # 🧠 fix pip → python -m pip
        if parts[0] == "pip":
            parts = [sys.executable, "-m"] + parts

        self.process.start(parts[0], parts[1:])

    def __init__(self):
        super().__init__()
        self.setWindowTitle("Futuristic Python IDE")
        self.resize(1100, 700)
        self.current_file = None

        layout = QVBoxLayout()

        top = QHBoxLayout()
        self.file_label = QLabel("No file")
        self.analyze_btn = QPushButton("🧠 ANALYZE")
        self.run_btn = QPushButton("▶ RUN")
        self.install_btn = QPushButton("📦 Install")
        top.addWidget(self.install_btn)
        self.install_btn.clicked.connect(self.install_package)

        top.addWidget(self.file_label)
        top.addStretch()
        top.addWidget(self.analyze_btn)
        top.addWidget(self.run_btn)
        layout.addLayout(top)

        mid = QHBoxLayout()
        self.file_list = QListWidget()
        self.file_list.setFixedWidth(200)

        self.editor = CodeEditor()
        self.highlighter = PythonHighlighter(self.editor.document())

        mid.addWidget(self.file_list)
        mid.addWidget(self.editor)
        layout.addLayout(mid)

        self.process = QProcess(self)
        self.terminal = TerminalWidget(self.process)
        self.terminal.hide()
        layout.addWidget(self.terminal)

        self.setLayout(layout)

        self.run_btn.clicked.connect(self.run_code)
        self.analyze_btn.clicked.connect(self.analyze_code)
        self.file_list.itemClicked.connect(self.load_file)

        self.process.readyReadStandardOutput.connect(self.read_stdout)
        self.process.readyReadStandardError.connect(self.read_stderr)
        self.process.finished.connect(self.process_finished)

        self.load_files()

    def load_files(self):
        self.file_list.clear()
        for f in os.listdir():
            if f.endswith(".py"):
                self.file_list.addItem(f)

    def load_file(self, item):
        self.current_file = item.text()
        self.file_label.setText(self.current_file)
        with open(self.current_file, "r", encoding="utf-8") as f:
            self.editor.setPlainText(f.read())

    def save_current(self):
        if not self.current_file:
            path, _ = QFileDialog.getSaveFileName(self, "Save", "", "Python (*.py)")
            if not path:
                return
            self.current_file = path
        with open(self.current_file, "w", encoding="utf-8") as f:
            f.write(self.editor.toPlainText())
        self.load_files()

    def run_code(self):
        self.save_current()
        if not self.current_file:
            return
        self.terminal.clear()
        self.terminal.show()
        self.process.start(sys.executable, ["-u", "-X", "utf8", self.current_file])

    def analyze_code(self):
        code = self.editor.toPlainText()

        self.terminal.clear()
        self.terminal.show()

        try:
            compile(code, self.current_file or "<string>", "exec")
            self.append_text("No syntax errors found.\n")
        except SyntaxError as e:
            self.append_text(f"SyntaxError: {e.msg} (line {e.lineno})\n")
        except Exception as e:
            self.append_text(str(e) + "\n")

    def read_stdout(self):
        self.append_text(self.process.readAllStandardOutput().data().decode())

    def read_stderr(self):
        self.append_text(self.process.readAllStandardError().data().decode())

    def append_text(self, text):
        self.terminal.append_ansi_text(text)

    def process_finished(self):
        self.append_text("\n[Process finished]\n")


# =========================
# 🚀 Main
# =========================
if __name__ == "__main__":
    app = QApplication(sys.argv)
    w = IDE()
    w.show()
    sys.exit(app.exec())

# ===== PTY TERMINAL INTEGRATION =====

from winpty import PtyProcess
import threading


class RealTerminalMixin:
    def start_pty(self):
        try:
            self.pty = PtyProcess.spawn("cmd.exe")
            self.terminal.attach_pty(self.pty)
            threading.Thread(target=self.read_pty, daemon=True).start()
        except Exception as e:
            self.append_text(f"PTY Error: {e}\n")

    def read_pty(self):
        while True:
            try:
                data = self.pty.read(1024)
                if data:
                    text = data.decode(errors="ignore")
                    self.terminal.append_ansi_text(text)
            except:
                break

    def send_to_pty(self, text):
        try:
            if hasattr(self, "pty"):
                self.pty.write(text)
        except:
            pass

