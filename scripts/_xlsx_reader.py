# -*- coding: utf-8 -*-
"""极简 xlsx 读取器（纯标准库，无需 openpyxl）。

xlsx 本质是 zip + XML，本模块只实现每日数据库更新脚本所需的最小能力：
  * 列出工作表名（wb.sheetnames）
  * 按表名读取行（wb[name].iter_rows(min_row=2, values_only=True) 的等价物）

支持：
  * 共享字符串（xl/sharedStrings.xml）
  * 内联字符串（<is><t>）
  * 数字、布尔值
  * 稀疏单元格（缺列补 None）

用法：
  wb = XlsxReader(path)
  for row in wb.rows("物品列表", min_row=2):
      print(row[0], row[1])
"""
import zipfile
import re
import xml.etree.ElementTree as ET

NS_MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
NS_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
NS_PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def _col_to_index(ref):
    """把单元格引用（如 'AB12'）的列部分转成 0 起始列号。"""
    m = re.match(r"([A-Z]+)", ref or "")
    if not m:
        return 0
    idx = 0
    for ch in m.group(1):
        idx = idx * 26 + (ord(ch) - 64)
    return idx - 1


class XlsxReader(object):
    """最小只读 xlsx 读取器，接口刻意贴近 openpyxl 的使用方式。"""

    def __init__(self, path):
        self.path = path
        self._z = zipfile.ZipFile(path)
        self._shared = self._load_shared_strings()
        self._sheets = self._load_sheet_map()

    # ---- 内部：解析 ----
    def _load_shared_strings(self):
        shared = []
        try:
            data = self._z.read("xl/sharedStrings.xml")
        except KeyError:
            return shared
        root = ET.fromstring(data)
        for si in root.findall(NS_MAIN + "si"):
            parts = [t.text or "" for t in si.iter(NS_MAIN + "t")]
            shared.append("".join(parts))
        return shared

    def _load_sheet_map(self):
        """返回 {工作表名: zip内路径}，按工作簿中的顺序。"""
        wb = ET.fromstring(self._z.read("xl/workbook.xml"))
        rels = {}
        try:
            rel_root = ET.fromstring(self._z.read("xl/_rels/workbook.xml.rels"))
            for rel in rel_root.findall(NS_PKG_REL + "Relationship"):
                rels[rel.get("Id")] = rel.get("Target")
        except KeyError:
            pass
        mapping = {}
        sheets_el = wb.find(NS_MAIN + "sheets")
        if sheets_el is None:
            return mapping
        for idx, sh in enumerate(sheets_el.findall(NS_MAIN + "sheet"), start=1):
            name = sh.get("name")
            rid = sh.get(NS_REL + "id")
            target = rels.get(rid)
            if target:
                if not target.startswith("xl/"):
                    target = "xl/" + target.lstrip("/")
                mapping[name] = target
            else:
                mapping[name] = "xl/worksheets/sheet%d.xml" % idx
        return mapping

    # ---- 公开接口 ----
    @property
    def sheetnames(self):
        return list(self._sheets.keys())

    def rows(self, name, min_row=1):
        """逐行产出（list），行内为单元格值列表，缺列补 None。"""
        path = self._sheets.get(name)
        if path is None:
            raise KeyError("找不到工作表：" + name)
        root = ET.fromstring(self._z.read(path))
        sheet_data = root.find(NS_MAIN + "sheetData")
        if sheet_data is None:
            return
        for row_el in sheet_data.findall(NS_MAIN + "row"):
            row_num = int(row_el.get("r") or 0)
            if row_num and row_num < min_row:
                continue
            cells = {}
            max_idx = -1
            for c in row_el.findall(NS_MAIN + "c"):
                ref = c.get("r") or ""
                ci = _col_to_index(ref) if ref else max_idx + 1
                cells[ci] = self._cell_value(c)
                if ci > max_idx:
                    max_idx = ci
            yield [cells.get(k) for k in range(max_idx + 1)]

    def _cell_value(self, c):
        ctype = c.get("t")
        if ctype == "inlineStr":
            is_el = c.find(NS_MAIN + "is")
            if is_el is None:
                return None
            return "".join(t.text or "" for t in is_el.iter(NS_MAIN + "t"))
        v = c.find(NS_MAIN + "v")
        if v is None or v.text is None:
            return None
        raw = v.text
        if ctype == "s":
            try:
                return self._shared[int(raw)]
            except (ValueError, IndexError):
                return None
        if ctype == "b":
            return raw == "1"
        try:
            num = float(raw)
        except ValueError:
            return raw
        return int(num) if num.is_integer() else num

    def close(self):
        try:
            self._z.close()
        except Exception:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False
