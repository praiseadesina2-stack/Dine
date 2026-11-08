// Type shim for the `input` package used in @dine/ai
declare module "input" {
  const input: {
    text(prompt: string): Promise<string>;
    password(prompt: string): Promise<string>;
  };
  export default input;
}

