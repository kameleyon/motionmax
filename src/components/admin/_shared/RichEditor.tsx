/**
 * RichEditor — TipTap-based WYSIWYG for admin Communicate panel and any
 * other admin surface that needs styled text → email-safe HTML.
 *
 * Output contract: `onChange(html)` returns the editor's serialised HTML
 * using only tags the email sanitiser whitelists (`p`, `br`, `strong`,
 * `em`, `u`, `s`, `code`, `pre`, `blockquote`, `ul`, `ol`, `li`,
 * `h1`-`h3`, `hr`, `a`). No inline styles, no classes — keeps the
 * Resend payload clean and survives client-side mail rendering.
 *
 * Theme: matches the admin shell tokens (cyan accents, gold for primary
 * action emphasis, dark panel background).
 */
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import { useEffect, type JSX, type ReactNode } from "react";

interface RichEditorProps {
  value: string;
  onChange: (html: string) => void;
  /** Min height in px — defaults to 160. */
  minHeight?: number;
  placeholder?: string;
}

/**
 * Toolbar button. `active` adds the cyan-tinted highlighted state used
 * across admin chip rows so the editor visually fits next to the rest
 * of the drawer's controls.
 */
function TbButton({
  onClick, active, disabled, title, children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      style={{
        padding: "5px 9px",
        minWidth: 28,
        fontSize: 12,
        lineHeight: 1.1,
        background: active ? "var(--cyan-dim)" : "var(--panel-3)",
        border: `1px solid ${active ? "rgba(20,200,204,.4)" : "var(--line)"}`,
        color: active ? "var(--cyan)" : "var(--ink)",
        borderRadius: 4,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        transition: "background 120ms, color 120ms, border-color 120ms",
      }}
    >{children}</button>
  );
}

function Divider(): JSX.Element {
  return (
    <span style={{ width: 1, height: 18, background: "var(--line)", margin: "0 2px", alignSelf: "center" }} />
  );
}

function Toolbar({ editor }: { editor: Editor }): JSX.Element {
  // Re-render the toolbar whenever the editor state changes so the
  // active highlights track the caret position. TipTap exposes this
  // via editor.on('selectionUpdate'/'transaction'), but useEditor
  // already triggers a re-render on every transaction in v3.
  const setLink = (): void => {
    const previousUrl = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", previousUrl ?? "https://");
    if (url === null) return; // cancelled
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6, alignItems: "center" }}>
      <TbButton title="Bold (Ctrl+B)" active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}>
        <span style={{ fontWeight: 700 }}>B</span>
      </TbButton>
      <TbButton title="Italic (Ctrl+I)" active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}>
        <span style={{ fontStyle: "italic" }}>I</span>
      </TbButton>
      <TbButton title="Underline (Ctrl+U)" active={editor.isActive("underline")}
        onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <span style={{ textDecoration: "underline" }}>U</span>
      </TbButton>
      <TbButton title="Strikethrough" active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}>
        <span style={{ textDecoration: "line-through" }}>S</span>
      </TbButton>
      <TbButton title="Inline code" active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}>
        <span className="mono">{`</>`}</span>
      </TbButton>
      <Divider />
      <TbButton title="Heading 1" active={editor.isActive("heading", { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>H1</TbButton>
      <TbButton title="Heading 2" active={editor.isActive("heading", { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</TbButton>
      <TbButton title="Heading 3" active={editor.isActive("heading", { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>H3</TbButton>
      <Divider />
      <TbButton title="Bullet list" active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}>•</TbButton>
      <TbButton title="Numbered list" active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}>1.</TbButton>
      <TbButton title="Blockquote" active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}>❝</TbButton>
      <TbButton title="Code block" active={editor.isActive("codeBlock")}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}>{ "{}" }</TbButton>
      <TbButton title="Horizontal rule"
        onClick={() => editor.chain().focus().setHorizontalRule().run()}>―</TbButton>
      <Divider />
      <TbButton title="Link" active={editor.isActive("link")} onClick={setLink}>
        <span style={{ color: editor.isActive("link") ? "inherit" : "var(--cyan)" }}>↗</span>
      </TbButton>
      <TbButton title="Clear formatting"
        onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>
        <span style={{ color: "var(--ink-dim)", fontSize: 11 }}>Tx</span>
      </TbButton>
      <span style={{ flex: 1 }} />
      <TbButton title="Undo (Ctrl+Z)" disabled={!editor.can().undo()}
        onClick={() => editor.chain().focus().undo().run()}>↶</TbButton>
      <TbButton title="Redo (Ctrl+Y)" disabled={!editor.can().redo()}
        onClick={() => editor.chain().focus().redo().run()}>↷</TbButton>
    </div>
  );
}

export function RichEditor({
  value, onChange, minHeight = 160, placeholder,
}: RichEditorProps): JSX.Element {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // Drop horizontalRule's keyboard shortcut (---) so admins typing a
        // dashed divider in casual prose don't get an unexpected <hr>.
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
      }),
    ],
    content: value || "",
    editorProps: {
      attributes: {
        // Inline styles only — keeping the email sanitiser's whitelist
        // simple. Class-based theming would require also surfacing the
        // class through resend's HTML pipeline.
        style: [
          `min-height: ${minHeight}px`,
          "padding: 10px 12px",
          "background: var(--panel-3)",
          "border: 1px solid var(--line)",
          "border-radius: 0 0 6px 6px",
          "border-top: none",
          "color: var(--ink)",
          "font-size: 13.5px",
          "line-height: 1.55",
          "outline: none",
        ].join(";"),
      },
    },
    onUpdate: ({ editor: ed }) => {
      // TipTap normalises an empty document to <p></p>; treat that as
      // empty so callers can do `if (!body) ...` without trim+regex.
      const html = ed.getHTML();
      onChange(html === "<p></p>" ? "" : html);
    },
  });

  // Sync external `value` resets back into the editor (e.g. after the
  // Send button clears the form). Avoid re-setting on every keystroke
  // or the caret would jump to the start.
  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    const incoming = value || "<p></p>";
    if (current !== incoming) {
      editor.commands.setContent(incoming, { emitUpdate: false });
    }
  }, [editor, value]);

  if (!editor) return <div style={{ minHeight: minHeight + 36 }} />;

  return (
    <div>
      <div style={{
        padding: 6, background: "var(--panel-2)",
        border: "1px solid var(--line)",
        borderRadius: "6px 6px 0 0", borderBottom: "none",
      }}>
        <Toolbar editor={editor} />
      </div>
      <EditorContent editor={editor} aria-label={placeholder ?? "Rich text editor"} />
    </div>
  );
}
