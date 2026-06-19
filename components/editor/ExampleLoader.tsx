'use client';

import { useState } from 'react';
import { useDiagramStore } from '@/lib/state/store';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import flowExample from '../../examples/flow.txt';
import tinyExample from '../../examples/tiny-flow.txt';
import sequenceExample from '../../examples/sequence.txt';
import umlExample from '../../examples/uml.txt';

interface DefaultProject {
  id: string;
  label: string;
  dsl: string;
}

const DEFAULT_PROJECTS: DefaultProject[] = [
  { id: 'default:saas', label: 'SaaS', dsl: flowExample as unknown as string },
  { id: 'default:flow', label: 'Flow', dsl: tinyExample as unknown as string },
  { id: 'default:sequence', label: 'Sequence', dsl: sequenceExample as unknown as string },
  { id: 'default:uml', label: 'UML', dsl: umlExample as unknown as string },
];

export function ExampleLoader() {
  const activeProjectId = useDiagramStore((s) => s.activeProjectId);
  const generatedProjects = useDiagramStore((s) => s.generatedProjects);
  const dslText = useDiagramStore((s) => s.dslText);
  const openProject = useDiagramStore((s) => s.openProject);
  const addGeneratedProject = useDiagramStore((s) => s.addGeneratedProject);
  const removeGeneratedProject = useDiagramStore((s) => s.removeGeneratedProject);
  const renameGeneratedProject = useDiagramStore((s) => s.renameGeneratedProject);
  const reorderGeneratedProjects = useDiagramStore((s) => s.reorderGeneratedProjects);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  // id of the project whose deletion is pending confirmation
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const loadProject = (project: { id: string; dsl: string; multiLayer?: typeof generatedProjects[number]['multiLayer'] }) => {
    // Root Cause vs Logic: project tabs previously copied only the DSL, so reopening a generated multi-layer project
    // discarded its stored layer bundle and looked like it had been overwritten. Load the full stored project context
    // instead so the active tab, DSL, and layer navigator stay aligned.
    openProject(project);
  };

  const commitRename = () => {
    if (editingId && editingName.trim()) {
      renameGeneratedProject(editingId, editingName.trim());
    }
    setEditingId(null);
  };

  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDraggingId(id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (id !== draggingId) setDragOverId(id);
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!draggingId || draggingId === targetId) {
      setDraggingId(null);
      setDragOverId(null);
      return;
    }
    const fromIdx = generatedProjects.findIndex((p) => p.id === draggingId);
    const toIdx = generatedProjects.findIndex((p) => p.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const reordered = [...generatedProjects];
    const [moved] = reordered.splice(fromIdx, 1);
    if (!moved) return;
    reordered.splice(toIdx, 0, moved);
    reorderGeneratedProjects(reordered);
    setDraggingId(null);
    setDragOverId(null);
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setDragOverId(null);
  };

  const handleAddProject = () => {
    addGeneratedProject('project1', dslText);
  };

  const pendingDeleteProject = generatedProjects.find((p) => p.id === pendingDeleteId);

  return (
    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      <span className="mr-1 flex shrink-0 items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-ink-400">
        <span>Projects</span>
        <button
          type="button"
          title="Add project"
          aria-label="Add project"
          onClick={handleAddProject}
          className="inline-flex h-5 w-5 items-center justify-center rounded border border-ink-700 bg-ink-900 text-ink-300 transition-colors hover:border-accent/50 hover:bg-ink-800 hover:text-ink-100"
        >
          +
        </button>
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {generatedProjects.map((proj) => {
          const isActive = activeProjectId === proj.id;
          const isDragging = draggingId === proj.id;
          const isDragOver = dragOverId === proj.id;
          const isEditing = editingId === proj.id;
          return (
            <span
              key={proj.id}
              draggable={!isEditing}
              onDragStart={(e) => handleDragStart(e, proj.id)}
              onDragOver={(e) => handleDragOver(e, proj.id)}
              onDrop={(e) => handleDrop(e, proj.id)}
              onDragEnd={handleDragEnd}
              className={`surface-transition group flex shrink-0 cursor-grab items-center gap-0.5 rounded-md border text-[11px] hover:-translate-y-0.5 ${
                isActive
                  ? 'border-accent/60 bg-accent/10'
                  : 'border-ink-700 bg-ink-900 hover:border-accent/50'
              } ${isDragging ? 'opacity-40' : ''} ${isDragOver ? 'ring-1 ring-accent/60' : ''}`}
            >
              {isEditing ? (
                <input
                  autoFocus
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="w-24 min-w-0 bg-transparent px-2.5 py-1.5 text-[11px] text-ink-100 outline-none"
                />
              ) : (
                <button
                  onClick={() => loadProject(proj)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditingId(proj.id);
                    setEditingName(proj.name);
                  }}
                  className={`cursor-grab px-2.5 py-1.5 ${isActive ? 'text-ink-100' : 'text-ink-200 hover:text-ink-100'}`}
                  type="button"
                >
                  {proj.name}
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingDeleteId(proj.id);
                }}
                className="mr-1 flex h-4 w-4 items-center justify-center rounded-sm text-ink-500 opacity-0 transition-opacity hover:bg-ink-700 hover:text-red-300 group-hover:opacity-100"
                type="button"
                title="Remove project"
              >
                ×
              </button>
            </span>
          );
        })}

        {generatedProjects.length > 0 && (
          <span className="shrink-0 text-ink-700">|</span>
        )}

        {DEFAULT_PROJECTS.map((proj) => {
          const isActive = activeProjectId === proj.id;
          return (
            <button
              key={proj.id}
              onClick={() => loadProject({ id: proj.id, dsl: proj.dsl })}
              className={`surface-transition shrink-0 rounded-md border px-2.5 py-1.5 text-[11px] hover:-translate-y-0.5 ${
                isActive
                  ? 'border-accent/60 bg-accent/10 text-ink-100'
                  : 'border-ink-700 bg-ink-900 text-ink-200 hover:border-accent/50 hover:text-ink-100'
              }`}
              type="button"
            >
              {proj.label}
            </button>
          );
        })}
      </div>

      <ConfirmDialog
        open={pendingDeleteId !== null}
        title="Delete project"
        message={`Delete "${pendingDeleteProject?.name ?? ''}" permanently? This cannot be undone.`}
        confirmLabel="Delete project"
        onConfirm={() => {
          if (pendingDeleteId) removeGeneratedProject(pendingDeleteId);
          setPendingDeleteId(null);
        }}
        onCancel={() => setPendingDeleteId(null)}
      />
    </div>
  );
}
