export class CommandNotImplementedError extends Error {
  constructor(command) {
    super(`${command} is not implemented yet`);
    this.name = 'CommandNotImplementedError';
  }
}

export async function main(request, dependencies = {}) {
  void dependencies;
  if (request.help) return 0;
  throw new CommandNotImplementedError(request.command);
}
