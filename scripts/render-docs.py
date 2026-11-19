"""Render the checked-in product and research Markdown as standalone pages."""
from pathlib import Path
import html
import re

root = Path(__file__).resolve().parents[1]
template = (root / 'dist/design.html').read_text().split('<body>')[0]
template = re.sub(r'<style(?: id="doc-extensions")?>\.design-body a.*?</style>', '', template, flags=re.S)
anchors = {
    '核心使用流程': 'core-flow', '数据模型': 'tasks', '项目匹配': 'projects',
    '连接器契约': 'connectors', '执行与凭据': 'delivery', '项目来源与同步': 'project-sources',
}


def inline(value):
    value = html.escape(value)
    value = re.sub(r'\[([^\]]+)\]\((https://[^\s)]+)\)',
                   r'<a href="\2" target="_blank" rel="noopener noreferrer">\1</a>', value)
    return value


def render(markdown):
    parts = []
    table = []
    listing = []

    def flush():
        if table:
            headers = table[0]
            rows = table[1:]
            parts.append('<div class="table-scroll"><table><thead><tr>' + ''.join(
                '<th scope="col">' + inline(c) + '</th>' for c in headers) + '</tr></thead><tbody>')
            for row in rows:
                parts.append('<tr>' + ''.join('<td>' + inline(c) + '</td>' for c in row) + '</tr>')
            parts.append('</tbody></table></div>')
            table.clear()
        if listing:
            parts.append('<ul>' + ''.join('<li>' + inline(c) + '</li>' for c in listing) + '</ul>')
            listing.clear()

    for line in markdown.splitlines():
        if line.startswith('|'):
            if listing:
                flush()
            cells = [c.strip() for c in line.strip('|').split('|')]
            if not all(re.fullmatch(r':?-+:?', c) for c in cells):
                table.append(cells)
            continue
        if line.startswith('- '):
            if table:
                flush()
            listing.append(line[2:])
            continue
        flush()
        if line.startswith('#'):
            level = len(line) - len(line.lstrip('#'))
            title = line[level:].strip()
            anchor = anchors.get(title, 'section-' + str(len(parts)))
            parts.append(f'<h{level} id="{anchor}">{inline(title)}</h{level}>')
        elif line:
            parts.append('<p>' + inline(line) + '</p>')
    flush()
    return '\n'.join(parts)


for source, target, title in [
    ('product-design.md', 'design.html', '产品设计'),
    ('project-sources.md', 'project-sources.html', '项目来源选型'),
    ('connector-implementation.md', 'implementation.html', 'Connector 接入说明'),
]:
    head = re.sub(r'<title>.*?</title>', f'<title>{title} · Progressive Agent</title>', template)
    styles = '<style id="doc-extensions">.design-body a{color:#6554bc;text-decoration:underline;text-underline-offset:3px}.design-body ul{padding-left:24px;color:#676e82;line-height:1.95}.design-body li{margin:10px 0}th{padding:13px 15px;border:1px solid #dde1eb;line-height:1.8;text-align:left;background:#eeeff7}.design-body th:first-child{min-width:135px}.design-body td:first-child{width:auto}tbody tr:first-child{font-weight:400;background:transparent}</style>'
    head = head.replace('</head>', styles + '</head>')
    body = '<body><nav class="design-nav shell"><a class="brand" href="index.html">progressive / agent</a>'
    body += f'<a href="assets/{source}" download>下载 Markdown</a></nav><main class="design-body">'
    body += render((root / 'dist/assets' / source).read_text())
    if target == 'design.html':
        body += '<p><a href="project-sources.html">阅读项目来源平台选型与官方资料</a> · <a href="implementation.html">Connector 接入说明</a></p>'
    (root / 'dist' / target).write_text(head + body + '</main></body></html>')
