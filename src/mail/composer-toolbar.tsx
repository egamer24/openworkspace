import { useEditorState, type Editor } from "@tiptap/react";
import {
  Bold,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Redo2,
  RemoveFormatting,
  Undo2,
  Underline,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function EditorButton({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={cn(active && "bg-accent text-accent-foreground")}
            disabled={disabled}
            aria-label={label}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function ComposerToolbar({
  editor,
  onChooseInlineImage,
  disabled,
}: {
  editor: Editor;
  /** Omit to hide the inline image button (e.g. signatures). */
  onChooseInlineImage?: () => void;
  disabled: boolean;
}) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      underline: current.isActive("underline"),
      link: current.isActive("link"),
      bulletList: current.isActive("bulletList"),
      orderedList: current.isActive("orderedList"),
      blockquote: current.isActive("blockquote"),
    }),
  });

  function applyLink() {
    const value = linkValue.trim();
    if (!value) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      setLinkOpen(false);
      return;
    }
    const href = /^[a-z][a-z0-9+.-]*:/iu.test(value)
      ? value
      : `https://${value}`;
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href })
      .run();
    setLinkValue("");
    setLinkOpen(false);
  }

  return (
    <div className="relative flex min-h-10 shrink-0 items-center gap-0.5 border-t border-border/70 px-3 py-1.5">
      <EditorButton
        label="Bold"
        active={state.bold}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold />
      </EditorButton>
      <EditorButton
        label="Italic"
        active={state.italic}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic />
      </EditorButton>
      <EditorButton
        label="Underline"
        active={state.underline}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        <Underline />
      </EditorButton>
      <EditorButton
        label="Link"
        active={state.link}
        disabled={disabled}
        onClick={() => {
          setLinkValue(editor.getAttributes("link").href ?? "");
          setLinkOpen((open) => !open);
        }}
      >
        <Link2 />
      </EditorButton>
      <span className="mx-1 h-4 w-px bg-border" />
      <EditorButton
        label="Bulleted list"
        active={state.bulletList}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List />
      </EditorButton>
      <EditorButton
        label="Numbered list"
        active={state.orderedList}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered />
      </EditorButton>
      <EditorButton
        label="Quote"
        active={state.blockquote}
        disabled={disabled}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote />
      </EditorButton>
      {onChooseInlineImage ? (
        <EditorButton
          label="Insert inline image"
          disabled={disabled}
          onClick={onChooseInlineImage}
        >
          <ImagePlus />
        </EditorButton>
      ) : null}
      <span className="mx-1 h-4 w-px bg-border" />
      <EditorButton
        label="Undo"
        disabled={disabled}
        onClick={() => editor.chain().focus().undo().run()}
      >
        <Undo2 />
      </EditorButton>
      <EditorButton
        label="Redo"
        disabled={disabled}
        onClick={() => editor.chain().focus().redo().run()}
      >
        <Redo2 />
      </EditorButton>
      <EditorButton
        label="Clear formatting"
        disabled={disabled}
        onClick={() =>
          editor.chain().focus().unsetAllMarks().clearNodes().run()}
      >
        <RemoveFormatting />
      </EditorButton>

      {linkOpen ? (
        <div className="absolute bottom-[calc(100%-2px)] left-20 z-50 flex w-72 items-center gap-1.5 rounded-xl bg-popover p-2 shadow-xl ring-1 ring-border">
          <Input
            className="h-8 min-w-0 flex-1"
            autoFocus
            disabled={disabled}
            value={linkValue}
            placeholder="https://example.com"
            aria-label="Link URL"
            onChange={(event) => setLinkValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                applyLink();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setLinkOpen(false);
                editor.commands.focus();
              }
            }}
          />
          <Button type="button" size="sm" disabled={disabled} onClick={applyLink}>
            Apply
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close link editor"
            disabled={disabled}
            onClick={() => setLinkOpen(false)}
          >
            <X />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
