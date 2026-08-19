export interface LiveTodo {
  id: string;
  text: string;
  done: boolean;
  updatedAt: number;
}

export class TodoBoard {
  private readonly items = new Map<string, LiveTodo>();

  constructor(private readonly runId: string) {}

  write(todos: Array<{ id?: string; text: string; done?: boolean }>): LiveTodo[] {
    const now = Date.now();
    const written: LiveTodo[] = [];
    for (const [index, todo] of todos.entries()) {
      const id = todo.id?.trim() || `todo:${this.runId}:${index + 1}`;
      const item: LiveTodo = {
        id,
        text: todo.text.trim(),
        done: Boolean(todo.done),
        updatedAt: now,
      };
      this.items.set(id, item);
      written.push(item);
    }
    return written;
  }

  update(id: string, patch: Partial<Pick<LiveTodo, 'text' | 'done'>>): LiveTodo | null {
    const current = this.items.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    this.items.set(id, next);
    return next;
  }

  list(): LiveTodo[] {
    return [...this.items.values()];
  }

  format(): string {
    const items = this.list();
    if (!items.length) return 'Live TODOs: none yet. Call todo_write to own the task list.';
    return ['Live TODOs:', ...items.map((item) => `- [${item.done ? 'x' : ' '}] ${item.id}: ${item.text}`)].join('\n');
  }
}
