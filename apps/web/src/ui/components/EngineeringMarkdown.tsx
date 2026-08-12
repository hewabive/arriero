import { Anchor, Code, Stack, Table, Text } from "@mantine/core";
import { type ReactNode, useMemo } from "react";

const hiddenEngineeringDocSections = new Set([
  "оригинальная справка",
  "оригинальная справка llama.cpp",
  "паспорт аргумента",
]);

type EngineeringMarkdownListItem = {
  text: string;
  children: EngineeringMarkdownList | null;
};

type EngineeringMarkdownList = {
  ordered: boolean;
  start: number;
  items: EngineeringMarkdownListItem[];
};

type EngineeringMarkdownBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; list: EngineeringMarkdownList }
  | { type: "code"; language: string | null; text: string }
  | { type: "table"; rows: string[][] };

function normalizeMarkdownHeading(value: string) {
  return value.replace(/[`#]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function trimBlankLines(lines: string[]) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]?.trim()) start += 1;
  while (end > start && !lines[end - 1]?.trim()) end -= 1;
  return lines.slice(start, end);
}

export function displayEngineeringMarkdown(input: {
  markdown: string;
  primaryName: string;
  title?: string | null;
}) {
  const titleHeadings = new Set(
    [input.primaryName, input.title]
      .filter((value): value is string => Boolean(value?.trim()))
      .map(normalizeMarkdownHeading),
  );
  const lines = input.markdown.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let skipLevel: number | null = null;

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      const normalized = normalizeMarkdownHeading(text);

      if (skipLevel !== null && level <= skipLevel) {
        skipLevel = null;
      }

      if (skipLevel === null) {
        if (level === 1 && titleHeadings.has(normalized)) {
          continue;
        }
        if (level <= 2 && hiddenEngineeringDocSections.has(normalized)) {
          skipLevel = level;
          continue;
        }
      }
    }

    if (skipLevel === null) {
      output.push(line);
    }
  }

  return trimBlankLines(output).join("\n");
}

function parseTableRow(line: string) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return null;
  }
  const withoutEdges = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return withoutEdges.split("|").map((cell) => cell.trim());
}

function isTableSeparator(row: string[]) {
  return row.length > 0 && row.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function matchListItem(line: string) {
  const match = line.match(/^(\s*)(?:[-*]|(\d+)\.)\s+(.+)$/);
  if (!match) {
    return null;
  }
  return {
    indent: match[1]!.length,
    ordered: match[2] !== undefined,
    start: match[2] ? Number.parseInt(match[2], 10) : 1,
    text: match[3]!.trim(),
  };
}

function isMarkdownBlockStart(lines: string[], index: number) {
  const line = lines[index] ?? "";
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("```")) return true;
  if (/^#{1,6}\s+/.test(trimmed)) return true;
  if (matchListItem(line)) return true;

  const row = parseTableRow(line);
  const nextRow = parseTableRow(lines[index + 1] ?? "");
  return Boolean(row && nextRow && isTableSeparator(nextRow));
}

function parseListLines(lines: string[], startIndex: number) {
  const first = matchListItem(lines[startIndex] ?? "")!;
  const root: EngineeringMarkdownList = {
    ordered: first.ordered,
    start: first.start,
    items: [],
  };
  const stack = [{ indent: first.indent, list: root }];
  let lastItem: EngineeringMarkdownListItem | null = null;
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim() || line.trim().startsWith("```")) {
      break;
    }

    const item = matchListItem(line);
    if (!item) {
      if (lastItem && /^\s{2,}\S/.test(line)) {
        lastItem.text = `${lastItem.text} ${line.trim()}`;
        index += 1;
        continue;
      }
      break;
    }

    while (stack.length > 1 && item.indent < stack[stack.length - 1]!.indent) {
      stack.pop();
    }
    let top = stack[stack.length - 1]!;
    const parent = top.list.items[top.list.items.length - 1];
    if (parent && item.indent >= top.indent + 2) {
      const child: EngineeringMarkdownList = {
        ordered: item.ordered,
        start: item.start,
        items: [],
      };
      parent.children = child;
      stack.push({ indent: item.indent, list: child });
      top = stack[stack.length - 1]!;
    }

    const entry: EngineeringMarkdownListItem = {
      text: item.text,
      children: null,
    };
    top.list.items.push(entry);
    lastItem = entry;
    index += 1;
  }

  return { list: root, nextIndex: index };
}

function parseEngineeringMarkdown(
  markdown: string,
): EngineeringMarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: EngineeringMarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const language = trimmed.slice(3).trim() || null;
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.trim().startsWith("```")) {
        code.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({ type: "code", language, text: code.join("\n") });
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1]!.length,
        text: heading[2]!.trim(),
      });
      index += 1;
      continue;
    }

    const tableHeader = parseTableRow(line);
    const tableSeparator = parseTableRow(lines[index + 1] ?? "");
    if (tableHeader && tableSeparator && isTableSeparator(tableSeparator)) {
      const rows: string[][] = [tableHeader];
      index += 2;
      while (index < lines.length) {
        const row = parseTableRow(lines[index] ?? "");
        if (!row) {
          break;
        }
        rows.push(row);
        index += 1;
      }
      blocks.push({ type: "table", rows });
      continue;
    }

    if (matchListItem(line)) {
      const parsed = parseListLines(lines, index);
      blocks.push({ type: "list", list: parsed.list });
      index = parsed.nextIndex;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && !isMarkdownBlockStart(lines, index)) {
      paragraph.push(lines[index]!.trim());
      index += 1;
    }
    blocks.push({
      type: "paragraph",
      text: paragraph.join(" ").replace(/\s+/g, " ").trim(),
    });
  }

  return blocks;
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const pattern =
    /(`[^`]+`|\[[^\]]+\]\([^)]+\)|<https?:\/\/[^>]+>|https?:\/\/[^\s)>]+|\*\*(?:[^*]|\*(?!\*))+?\*\*|(?<![\p{L}\p{N}*])\*(?!\s)[^*]*[^*\s]\*(?![\p{L}\p{N}*]))/gu;
  const nodes: ReactNode[] = [];
  let offset = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > offset) {
      nodes.push(text.slice(offset, match.index));
    }

    const token = match[0];
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <strong key={`strong-${match.index}`}>
          {renderInlineMarkdown(token.slice(2, -2))}
        </strong>,
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <Code key={`code-${match.index}`} component="span">
          {token.slice(1, -1)}
        </Code>,
      );
    } else if (link) {
      nodes.push(
        <Anchor
          key={`link-${match.index}`}
          href={link[2]}
          target="_blank"
          rel="noreferrer"
        >
          {link[1]}
        </Anchor>,
      );
    } else if (token.startsWith("*") && token.endsWith("*")) {
      nodes.push(
        <em key={`em-${match.index}`}>
          {renderInlineMarkdown(token.slice(1, -1))}
        </em>,
      );
    } else {
      const href =
        token.startsWith("<") && token.endsWith(">")
          ? token.slice(1, -1)
          : token;
      nodes.push(
        <Anchor
          key={`url-${match.index}`}
          href={href}
          target="_blank"
          rel="noreferrer"
        >
          {href}
        </Anchor>,
      );
    }
    offset = match.index + token.length;
  }

  if (offset < text.length) {
    nodes.push(text.slice(offset));
  }

  return nodes;
}

function renderMarkdownList(
  list: EngineeringMarkdownList,
  key: string,
): ReactNode {
  const items = list.items.map((item, index) => (
    <li key={index}>
      {renderInlineMarkdown(item.text)}
      {item.children
        ? renderMarkdownList(item.children, `${key}-${index}`)
        : null}
    </li>
  ));
  if (list.ordered) {
    return (
      <ol key={key} className="argument-doc-list" start={list.start}>
        {items}
      </ol>
    );
  }
  return (
    <ul key={key} className="argument-doc-list">
      {items}
    </ul>
  );
}

export function EngineeringMarkdown(props: { markdown: string }) {
  const blocks = useMemo(
    () => parseEngineeringMarkdown(props.markdown),
    [props.markdown],
  );

  return (
    <Stack className="argument-doc-rendered" gap="xs">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          return (
            <Text
              key={`${block.type}-${index}`}
              fw={700}
              mt={index === 0 ? 0 : "sm"}
              size={block.level <= 2 ? "sm" : "xs"}
            >
              {renderInlineMarkdown(block.text)}
            </Text>
          );
        }
        if (block.type === "paragraph") {
          return (
            <Text
              key={`${block.type}-${index}`}
              className="text-wrap"
              size="sm"
            >
              {renderInlineMarkdown(block.text)}
            </Text>
          );
        }
        if (block.type === "list") {
          return renderMarkdownList(block.list, `${block.type}-${index}`);
        }
        if (block.type === "table") {
          const [head, ...body] = block.rows;
          return (
            <Table.ScrollContainer
              key={`${block.type}-${index}`}
              minWidth={480}
            >
              <Table className="argument-doc-table" verticalSpacing={4}>
                {head && (
                  <Table.Thead>
                    <Table.Tr>
                      {head.map((cell, cellIndex) => (
                        <Table.Th key={cellIndex}>
                          {renderInlineMarkdown(cell)}
                        </Table.Th>
                      ))}
                    </Table.Tr>
                  </Table.Thead>
                )}
                <Table.Tbody>
                  {body.map((row, rowIndex) => (
                    <Table.Tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <Table.Td key={cellIndex}>
                          {renderInlineMarkdown(cell)}
                        </Table.Td>
                      ))}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          );
        }
        return (
          <Code
            key={`${block.type}-${index}`}
            block
            className="argument-doc-code"
          >
            {block.text}
          </Code>
        );
      })}
    </Stack>
  );
}
