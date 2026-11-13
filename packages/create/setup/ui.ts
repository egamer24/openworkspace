// The terminal conversation, behind an interface so the flow can be driven
// by a script in tests. `clackUi` is the real one.
import * as p from "@clack/prompts";

export type Choice<T extends string> = {
  value: T;
  label: string;
  hint?: string;
};

export type Ui = {
  intro(title: string): void;
  outro(message: string): void;
  cancel(message: string): void;
  text(prompt: {
    message: string;
    placeholder?: string;
    initialValue?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
  password(prompt: { message: string }): Promise<string>;
  confirm(prompt: {
    message: string;
    initialValue?: boolean;
  }): Promise<boolean>;
  select<T extends string>(prompt: {
    message: string;
    options: Choice<T>[];
    initialValue?: T;
  }): Promise<T>;
  multiselect<T extends string>(prompt: {
    message: string;
    options: Choice<T>[];
    initialValues?: T[];
  }): Promise<T[]>;
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  step(message: string): void;
  note(message: string, title: string): void;
  /** Shows `message` while `work` runs, then `done(result)`. */
  progress<T>(
    message: string,
    work: () => Promise<T>,
    done: (result: T) => string
  ): Promise<T>;
};

/** A prompt the person cancelled (Ctrl-C or Esc). */
export class Cancelled extends Error {
  constructor() {
    super("Cancelled");
  }
}

function answered<T>(value: T | symbol): T {
  if (p.isCancel(value)) throw new Cancelled();

  // SAFETY: clack resolves a prompt with its answer or its cancel symbol, ruled out above.
  return value as T;
}

export const clackUi: Ui = {
  intro: (title) => p.intro(title),
  outro: (message) => p.outro(message),
  cancel: (message) => p.cancel(message),
  async text(prompt) {
    const { validate } = prompt;

    return answered<string>(
      await p.text({
        message: prompt.message,
        placeholder: prompt.placeholder,
        initialValue: prompt.initialValue,
        validate: validate && ((value) => validate(value ?? "")),
      })
    );
  },
  async password(prompt) {
    return answered<string>(await p.password({ message: prompt.message }));
  },
  async confirm(prompt) {
    return answered<boolean>(await p.confirm(prompt));
  },
  async select(prompt) {
    const value = answered<string>(
      await p.select<string>({
        message: prompt.message,
        options: prompt.options,
        initialValue: prompt.initialValue,
      })
    );

    const chosen = prompt.options.find((option) => option.value === value);

    if (!chosen) throw new Error(`Unknown choice: ${value}`);

    return chosen.value;
  },
  async multiselect(prompt) {
    const values = answered<string[]>(
      await p.multiselect<string>({
        message: prompt.message,
        options: prompt.options,
        initialValues: prompt.initialValues,
        required: true,
      })
    );

    return prompt.options
      .filter((option) => values.includes(option.value))
      .map((option) => option.value);
  },
  info: (message) => p.log.info(message),
  success: (message) => p.log.success(message),
  warn: (message) => p.log.warn(message),
  error: (message) => p.log.error(message),
  step: (message) => p.log.step(message),
  note: (message, title) => p.note(message, title),
  async progress(message, work, done) {
    // A spinner's frames are noise in a log: without a terminal, only the outcome is printed.
    if (!process.stdout.isTTY) {
      const result = await work();

      p.log.step(done(result));

      return result;
    }

    const spinner = p.spinner();

    spinner.start(message);

    try {
      const result = await work();

      spinner.stop(done(result));

      return result;
    } catch (failure) {
      spinner.error(message);
      throw failure;
    }
  },
};
