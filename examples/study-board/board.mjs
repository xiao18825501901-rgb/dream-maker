export function add(tasks, title, id) { const value = String(title).trim(); if (!value || value.length > 120)
    throw Error('INVALID_TITLE'); if (tasks.some(t => t.id === id))
    throw Error('DUPLICATE_ID'); return [...tasks, { id, title: value, done: false }]; }
export function toggle(tasks, id) { return tasks.map(task => task.id === id ? { ...task, done: !task.done } : task); }
export function remove(tasks, id) { return tasks.filter(task => task.id !== id); }
export function stats(tasks) { return { total: tasks.length, done: tasks.filter(t => t.done).length, active: tasks.filter(t => !t.done).length }; }
export function restore(raw) { try {
    const t = JSON.parse(raw);
    return Array.isArray(t) ? t.filter(x => x && typeof x.id === 'string' && typeof x.title === 'string' && typeof x.done === 'boolean').slice(0, 1000) : [];
}
catch {
    return [];
} }
