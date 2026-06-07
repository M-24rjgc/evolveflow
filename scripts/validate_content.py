#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EvolveFlow 需求规格说明书 - 内容验证脚本
验证生成的 DOCX 文档是否满足要求
"""

import zipfile
import xml.etree.ElementTree as ET
import os
import re
import sys

DOCX_PATH = r'c:\Users\52376\Desktop\课程与学习\软件工程\evolveflow\课程提交文档\02_需求规格说明书.docx'

def extract_text_from_docx(docx_path):
    """从 DOCX 文件中提取纯文本"""
    text_parts = []
    try:
        with zipfile.ZipFile(docx_path, 'r') as z:
            if 'word/document.xml' not in z.namelist():
                print("[ERROR] word/document.xml not found in DOCX")
                return ""
            xml_content = z.read('word/document.xml')
            root = ET.fromstring(xml_content)

            # Define namespace
            ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}

            # Extract all text from w:t elements
            for t_elem in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t'):
                if t_elem.text:
                    text_parts.append(t_elem.text)

            # Add newlines for paragraph breaks
            full_text = ''.join(text_parts)
    except Exception as e:
        print(f"[ERROR] Failed to extract text: {e}")
        return ""

    return full_text

def count_tables(docx_path):
    """统计 DOCX 中的表格数量"""
    try:
        with zipfile.ZipFile(docx_path, 'r') as z:
            xml_content = z.read('word/document.xml')
            root = ET.fromstring(xml_content)
            ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
            tables = root.findall('.//w:tbl', ns)
            return len(tables)
    except Exception as e:
        print(f"[ERROR] Failed to count tables: {e}")
        return 0

def main():
    print("=" * 70)
    print("EvolveFlow 需求规格说明书 - 内容验证")
    print("=" * 70)
    print()

    # Check file exists
    if not os.path.exists(DOCX_PATH):
        print(f"[FAIL] 文档文件不存在: {DOCX_PATH}")
        sys.exit(1)
    print(f"[PASS] 文档文件存在")

    # File size check
    file_size = os.path.getsize(DOCX_PATH)
    print(f"[INFO] 文件大小: {file_size:,} bytes ({file_size/1024:.1f} KB)")

    if file_size < 30000:
        print(f"[WARN] 文件大小较小 ({file_size} bytes)，可能内容不完整")
    else:
        print(f"[PASS] 文件大小合理（>30KB）")

    # Extract text
    text = extract_text_from_docx(DOCX_PATH)
    text_length = len(text)
    print(f"[INFO] 提取文本长度: {text_length} 字符")

    if text_length < 5000:
        print(f"[FAIL] 文本内容过少 ({text_length} 字符)，至少需要5000字符")
    else:
        print(f"[PASS] 文本内容充足（>5000字符）")

    # Count tables
    table_count = count_tables(DOCX_PATH)
    print(f"[INFO] 表格数量: {table_count}")

    if table_count < 5:
        print(f"[FAIL] 表格数量不足：{table_count} 个（要求至少5个）")
    else:
        print(f"[PASS] 表格数量达标：{table_count} 个（要求≥5个）")

    # Check required sections
    print()
    print("--- 必需章节检查 ---")

    required_sections = [
        ('引言', '第1章'),
        ('编写目的', '1.1'),
        ('项目背景', '1.2'),
        ('定义', '1.3'),
        ('参考资料', '1.4'),
        ('需求概述', '第2章'),
        ('目标', '2.1'),
        ('运行环境', '2.2'),
        ('条件与限制', '2.3'),
        ('功能需求', '第3章'),
        ('确定执行者', '3.1'),
        ('确定用例', '3.2'),
        ('编写用例文档', '3.3'),
        ('非功能需求', '第4章'),
        ('性能需求', '4.1'),
        ('安全需求', '4.2'),
        ('可用性需求', '4.3'),
        ('可靠性需求', '4.4'),
        ('故障处理', '第5章'),
        ('其它需求', '第6章'),
    ]

    all_required_found = True
    for keyword, section_id in required_sections:
        if keyword in text:
            print(f"  [PASS] {section_id} {keyword}")
        else:
            print(f"  [FAIL] {section_id} {keyword} - 未找到")
            all_required_found = False

    # Check use cases
    print()
    print("--- 用例检查 ---")

    use_cases = [
        'UC01', 'UC02', 'UC03', 'UC04', 'UC05',
        'UC06', 'UC07', 'UC08', 'UC09', 'UC10',
        'UC11', 'UC12', 'UC13', 'UC14', 'UC15',
    ]

    missing_ucs = []
    for uc in use_cases:
        if uc in text:
            pass
        else:
            missing_ucs.append(uc)

    if missing_ucs:
        print(f"  [FAIL] 缺失用例: {', '.join(missing_ucs)}")
    else:
        print(f"  [PASS] 所有15个用例均已包含")

    # Check key terms / definitions
    print()
    print("--- 关键术语检查 ---")

    key_terms = [
        'EvolveFlow', 'Tauri', 'Sidecar', 'SQLite', 'WAL',
        'Dream', 'Buddy', 'Capability Registry', 'JSON-RPC', 'SSE',
        'Undo', 'Redo', '幂等性',
    ]

    for term in key_terms:
        if term.lower() in text.lower():
            print(f"  [PASS] 术语 '{term}' 已包含")
        else:
            print(f"  [WARN] 术语 '{term}' 未找到")

    # Check key technical details
    print()
    print("--- 技术细节检查 ---")

    tech_details = [
        ('加权评分', '智能排程算法描述'),
        ('五维', '评分维度'),
        ('能量模式', 'Dream分析'),
        ('状态快照', '撤销机制'),
        ('降级', '三级降级状态'),
        ('ai_offline', 'AI离线模式'),
        ('critical', '紧急模式'),
        ('SHA-256', '备份完整性'),
        ('指数退避', '重试策略'),
        ('Anthropic', 'AI提供商'),
        ('DeepSeek', 'AI提供商'),
        ('MIT', '开源协议'),
        ('TypeScript', '技术栈'),
        ('Rust', '技术栈'),
        ('React', '技术栈'),
        ('Vite', '技术栈'),
    ]

    for term, context in tech_details:
        if term.lower() in text.lower():
            print(f"  [PASS] '{term}' ({context}) 已包含")
        else:
            print(f"  [WARN] '{term}' ({context}) 未找到")

    # Summary
    print()
    print("=" * 70)
    print("验证总结")
    print("=" * 70)
    print(f"  文档文件: {DOCX_PATH}")
    print(f"  文件大小: {file_size:,} bytes ({file_size/1024:.1f} KB)")
    print(f"  文本长度: {text_length} 字符")
    print(f"  表格数量: {table_count}")
    print(f"  章节完整性: {'通过' if all_required_found else '存在缺失'}")
    print(f"  用例完整性: {'通过' if not missing_ucs else '缺失' + str(len(missing_ucs)) + '个'}")

    if all_required_found and table_count >= 5 and text_length >= 5000 and not missing_ucs:
        print()
        print("  [PASS] 文档验证通过！需求规格说明书符合所有要求。")
        return 0
    else:
        print()
        print("  [FAIL] 文档验证未通过，请检查上述问题。")
        return 1

if __name__ == '__main__':
    sys.exit(main())
