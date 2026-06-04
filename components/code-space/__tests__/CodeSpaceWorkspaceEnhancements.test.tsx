import { afterEach, describe, expect, it, vi } from 'vitest';
import { isClickInsideExplorerMenu, postFileAction } from '../CodeSpaceWorkspaceEnhancements';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('postFileAction', () => {
  it('posts a filesystem mutation to the Code Space files API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ createdAt: Date.now() }),
    } as Response);
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    const result = await postFileAction(
      {
        projectId: 'project-1',
        rootPath: '/workspace/medbot',
        path: 'backend/memory',
        name: 'memory',
        type: 'dir',
        directoryPath: 'backend',
      },
      {
        action: 'mkdir',
        path: 'backend/memory/new-folder',
      },
      'backend/memory',
    );

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/code-space/files',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          rootPath: '/workspace/medbot',
          action: 'mkdir',
          path: 'backend/memory/new-folder',
        }),
      }),
    );
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const refreshEvent = dispatchSpy.mock.calls[0]?.[0] as CustomEvent<{
      projectId: string;
      rootPath: string;
      folderPath: string;
    }>;
    expect(refreshEvent.type).toBe('code-space:refresh-tree');
    expect(refreshEvent.detail).toEqual({
      projectId: 'project-1',
      rootPath: '/workspace/medbot',
      folderPath: 'backend/memory',
    });
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe('isClickInsideExplorerMenu', () => {
  it('recognizes clicks inside the custom explorer menu container', () => {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-code-space-explorer-menu', 'true');
    const menuButton = document.createElement('button');
    wrapper.appendChild(menuButton);
    document.body.appendChild(wrapper);

    expect(isClickInsideExplorerMenu(menuButton)).toBe(true);
    expect(isClickInsideExplorerMenu(wrapper)).toBe(true);
    expect(isClickInsideExplorerMenu(document.createElement('button'))).toBe(false);
  });
});
