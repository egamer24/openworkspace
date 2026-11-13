import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Toggle,
  toggleVariants,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@open-workspace/core/ui";
import { useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
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
import { useRef, useState } from "react";
import type { ReactNode } from "react";

/** A formatting toggle: pressed while the selection has the format. */
function FormatToggle({
  label,
  pressed,
  disabled,
  onToggle,
  children,
}: {
  label: string;
  pressed: boolean;
  disabled: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            size="xs"
            pressed={pressed}
            disabled={disabled}
            aria-label={label}
            onPressedChange={onToggle}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** A one-shot editor command, such as Undo. */
function EditorButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
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
  onChooseInlineImage: () => void;
  disabled: boolean;
}) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  // Applying a link returns to the text; any other close returns to the Link button.
  const returnToEditor = useRef(false);

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

  function closeLinkEditor(toEditor: boolean) {
    returnToEditor.current = toEditor;
    setLinkOpen(false);
  }

  function applyLink() {
    const value = linkValue.trim();

    if (!value) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      closeLinkEditor(true);

      return;
    }

    const href = /^[a-z][a-z0-9+.-]*:/iu.test(value)
      ? value
      : `https://${value}`;

    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    setLinkValue("");
    closeLinkEditor(true);
  }

  return (
    <div className="border-border/70 relative flex min-h-10 shrink-0 items-center gap-0.5 border-t px-3 py-1.5">
      <FormatToggle
        label="Bold"
        pressed={state.bold}
        disabled={disabled}
        onToggle={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold />
      </FormatToggle>
      <FormatToggle
        label="Italic"
        pressed={state.italic}
        disabled={disabled}
        onToggle={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic />
      </FormatToggle>
      <FormatToggle
        label="Underline"
        pressed={state.underline}
        disabled={disabled}
        onToggle={() => editor.chain().focus().toggleUnderline().run()}
      >
        <Underline />
      </FormatToggle>
      <Popover
        open={linkOpen}
        onOpenChange={(open) => {
          if (open) {
            returnToEditor.current = false;
            setLinkValue(editor.getAttributes("link").href ?? "");
          }

          setLinkOpen(open);
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                // Looks pressed inside a link; the open editor shows the URL.
                data-pressed={state.link || undefined}
                className={toggleVariants({ size: "xs" })}
                disabled={disabled}
                aria-label="Link"
              />
            }
          >
            <Link2 />
          </TooltipTrigger>
          <TooltipContent>Link</TooltipContent>
        </Tooltip>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="flex w-72 items-center gap-1.5 p-2"
          aria-label="Link editor"
          finalFocus={() => !returnToEditor.current}
        >
          <Input
            className="h-8 min-w-0 flex-1"
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
            }}
          />
          <Button
            type="button"
            size="sm"
            disabled={disabled}
            onClick={applyLink}
          >
            Apply
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close link editor"
            disabled={disabled}
            onClick={() => closeLinkEditor(false)}
          >
            <X />
          </Button>
        </PopoverContent>
      </Popover>
      <span className="bg-border mx-1 h-4 w-px" />
      <FormatToggle
        label="Bulleted list"
        pressed={state.bulletList}
        disabled={disabled}
        onToggle={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List />
      </FormatToggle>
      <FormatToggle
        label="Numbered list"
        pressed={state.orderedList}
        disabled={disabled}
        onToggle={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered />
      </FormatToggle>
      <FormatToggle
        label="Quote"
        pressed={state.blockquote}
        disabled={disabled}
        onToggle={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote />
      </FormatToggle>
      <EditorButton
        label="Insert inline image"
        disabled={disabled}
        onClick={onChooseInlineImage}
      >
        <ImagePlus />
      </EditorButton>
      <span className="bg-border mx-1 h-4 w-px" />
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
          editor.chain().focus().unsetAllMarks().clearNodes().run()
        }
      >
        <RemoveFormatting />
      </EditorButton>
    </div>
  );
}
