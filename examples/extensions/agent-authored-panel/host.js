import manifest from './varin.extension.json';
export default {
  activate(context) {
    const descriptor = manifest.provides.services[0];
    context.services.provide(descriptor, {
      inspect(args) {
        if (args.length !== 0) throw new Error('Tool inspect takes no arguments');
        return descriptor;
      },
      execute(args, call) {
        call.signal.throwIfAborted();
        if (args.length !== 1 || typeof args[0]?.text !== 'string') throw new Error('One text input is required');
        const text = args[0].text;
        return { words: text.trim() ? text.trim().split(/\s+/u).length : 0, characters: [...text].length };
      },
    });
  },
};
