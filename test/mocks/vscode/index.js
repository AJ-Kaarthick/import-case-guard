class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(startLineOrPos, startChar, endLine, endChar) {
    if (typeof startLineOrPos === 'object') {
      this.start = startLineOrPos;
      this.end = startChar;
    } else {
      this.start = new Position(startLineOrPos, startChar);
      this.end = new Position(endLine, endChar);
    }
  }

  contains(position) {
    if (position.line < this.start.line || position.line > this.end.line) return false;
    if (position.line === this.start.line && position.character < this.start.character) return false;
    if (position.line === this.end.line && position.character > this.end.character) return false;
    return true;
  }

  isEqual(other) {
    return (
      this.start.line === other.start.line &&
      this.start.character === other.start.character &&
      this.end.line === other.end.line &&
      this.end.character === other.end.character
    );
  }
}

const DiagnosticSeverity = {
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
};

class Diagnostic {
  constructor(range, message, severity = DiagnosticSeverity.Error) {
    this.range = range;
    this.message = message;
    this.severity = severity;
    this.source = '';
    this.code = '';
  }
}

const CodeActionKind = {
  QuickFix: 'quickfix',
};

class CodeAction {
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
    this.diagnostics = [];
    this.isPreferred = false;
  }
}

class WorkspaceEdit {
  constructor() {
    this.edits = [];
  }

  replace(uri, range, newText) {
    this.edits.push({ uri, range, newText });
  }
}

const registeredCommands = new Map();

const workspace = {
  workspaceFolders: undefined,
  textDocuments: [],
  appliedEdits: [],
  _mockFs: undefined,
  getWorkspaceFolder: () => undefined,
  _openListeners: [],
  onDidOpenTextDocument: (fn) => {
    workspace._openListeners.push(fn);
    return {
      dispose: () => {
        const idx = workspace._openListeners.indexOf(fn);
        if (idx >= 0) workspace._openListeners.splice(idx, 1);
      },
    };
  },
  _changeListeners: [],
  onDidChangeTextDocument: (fn) => {
    workspace._changeListeners.push(fn);
    return {
      dispose: () => {
        const idx = workspace._changeListeners.indexOf(fn);
        if (idx >= 0) workspace._changeListeners.splice(idx, 1);
      },
    };
  },
  _saveListeners: [],
  onDidSaveTextDocument: (fn) => {
    workspace._saveListeners.push(fn);
    return {
      dispose: () => {
        const idx = workspace._saveListeners.indexOf(fn);
        if (idx >= 0) workspace._saveListeners.splice(idx, 1);
      },
    };
  },
  _closeListeners: [],
  onDidCloseTextDocument: (fn) => {
    workspace._closeListeners.push(fn);
    return {
      dispose: () => {
        const idx = workspace._closeListeners.indexOf(fn);
        if (idx >= 0) workspace._closeListeners.splice(idx, 1);
      },
    };
  },
  _configListeners: [],
  onDidChangeConfiguration: (fn) => {
    workspace._configListeners.push(fn);
    return {
      dispose: () => {
        const idx = workspace._configListeners.indexOf(fn);
        if (idx >= 0) workspace._configListeners.splice(idx, 1);
      },
    };
  },
  _fireOpenTextDocument: (doc) => {
    for (const fn of [...workspace._openListeners]) fn(doc);
  },
  _fireChangeTextDocument: (event) => {
    for (const fn of [...workspace._changeListeners]) fn(event);
  },
  _fireSaveTextDocument: (doc) => {
    for (const fn of [...workspace._saveListeners]) fn(doc);
  },
  _fireCloseTextDocument: (doc) => {
    for (const fn of [...workspace._closeListeners]) fn(doc);
  },
  _fireChangeConfiguration: (e) => {
    for (const fn of [...workspace._configListeners]) fn(e);
  },
  _resetAll: () => {
    workspace._openListeners = [];
    workspace._changeListeners = [];
    workspace._saveListeners = [];
    workspace._closeListeners = [];
    workspace._configListeners = [];
    workspace._watchers = [];
    workspace.textDocuments = [];
    workspace.appliedEdits = [];
    workspace.workspaceFolders = undefined;
    window._activeEditorListeners = [];
    window.visibleTextEditors = [];
    window.activeTextEditor = undefined;
    registeredCommands.clear();
  },
  _watchers: [],
  createFileSystemWatcher: (glob) => {
    const watcher = {
      glob,
      _createListeners: [],
      _changeListeners: [],
      _deleteListeners: [],
      onDidCreate: (fn) => {
        watcher._createListeners.push(fn);
        return {
          dispose: () => {
            const idx = watcher._createListeners.indexOf(fn);
            if (idx >= 0) watcher._createListeners.splice(idx, 1);
          },
        };
      },
      onDidChange: (fn) => {
        watcher._changeListeners.push(fn);
        return {
          dispose: () => {
            const idx = watcher._changeListeners.indexOf(fn);
            if (idx >= 0) watcher._changeListeners.splice(idx, 1);
          },
        };
      },
      onDidDelete: (fn) => {
        watcher._deleteListeners.push(fn);
        return {
          dispose: () => {
            const idx = watcher._deleteListeners.indexOf(fn);
            if (idx >= 0) watcher._deleteListeners.splice(idx, 1);
          },
        };
      },
      fireCreate: (uri) => {
        for (const fn of [...watcher._createListeners]) fn(uri);
      },
      fireChange: (uri) => {
        for (const fn of [...watcher._changeListeners]) fn(uri);
      },
      fireDelete: (uri) => {
        for (const fn of [...watcher._deleteListeners]) fn(uri);
      },
      dispose: () => {
        watcher._createListeners = [];
        watcher._changeListeners = [];
        watcher._deleteListeners = [];
      },
    };
    workspace._watchers.push(watcher);
    return watcher;
  },
  getConfiguration: () => ({
    get: (key, def) => def,
  }),
  applyEdit: (workspaceEdit) => {
    workspace.appliedEdits.push(...workspaceEdit.edits);
    for (const edit of workspaceEdit.edits) {
      const uriStr = edit.uri.toString ? edit.uri.toString() : String(edit.uri);
      const fsPath = edit.uri.fsPath || uriStr.replace('file://', '');
      const doc = workspace.textDocuments.find((d) => d.uri.toString() === uriStr);
      if (doc && typeof doc.applyEdit === 'function') {
        doc.applyEdit(edit.range, edit.newText);
      }
      if (workspace._mockFs && typeof workspace._mockFs.applyEdit === 'function') {
        workspace._mockFs.applyEdit(fsPath, edit.range, edit.newText);
      }
    }
    return Promise.resolve(true);
  },
};

const languages = {
  createDiagnosticCollection: (name) => {
    const store = new Map();
    return {
      name,
      set: (uri, diags) => {
        const key = uri.toString ? uri.toString() : String(uri);
        store.set(key, diags || []);
      },
      get: (uri) => {
        const key = uri.toString ? uri.toString() : String(uri);
        return store.get(key);
      },
      has: (uri) => {
        const key = uri.toString ? uri.toString() : String(uri);
        return store.has(key);
      },
      delete: (uri) => {
        const key = uri.toString ? uri.toString() : String(uri);
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
      dispose: () => {
        store.clear();
      },
    };
  },
  registerHoverProvider: () => ({ dispose: () => {} }),
  registerCodeActionsProvider: () => ({ dispose: () => {} }),
};

const window = {
  visibleTextEditors: [],
  activeTextEditor: undefined,
  _activeEditorListeners: [],
  _fireChangeActiveTextEditor: (editor) => {
    for (const fn of [...window._activeEditorListeners]) fn(editor);
  },
  onDidChangeActiveTextEditor: (fn) => {
    window._activeEditorListeners.push(fn);
    return {
      dispose: () => {
        const idx = window._activeEditorListeners.indexOf(fn);
        if (idx >= 0) window._activeEditorListeners.splice(idx, 1);
      },
    };
  },
  lastInformationMessage: undefined,
  lastWarningMessage: undefined,
  lastErrorMessage: undefined,
  confirmationResponse: undefined,
  showInformationMessage: (msg, ...items) => {
    window.lastInformationMessage = msg;
    if (items.length > 0) {
      const response = window.confirmationResponse !== undefined ? window.confirmationResponse : items[0];
      return Promise.resolve(response);
    }
    return Promise.resolve();
  },
  showWarningMessage: (msg, ...items) => {
    window.lastWarningMessage = msg;
    if (items.length > 0) {
      const response = window.confirmationResponse !== undefined ? window.confirmationResponse : items[0];
      return Promise.resolve(response);
    }
    return Promise.resolve();
  },
  showErrorMessage: (msg, ...items) => {
    window.lastErrorMessage = msg;
    if (items.length > 0) {
      const response = window.confirmationResponse !== undefined ? window.confirmationResponse : items[0];
      return Promise.resolve(response);
    }
    return Promise.resolve();
  },
};

const commands = {
  registerCommand: (command, callback) => {
    registeredCommands.set(command, callback);
    return {
      dispose: () => {
        registeredCommands.delete(command);
      },
    };
  },
  executeCommand: (command, ...args) => {
    const fn = registeredCommands.get(command);
    if (fn) {
      return Promise.resolve(fn(...args));
    }
    return Promise.resolve();
  },
};

const Uri = {
  file: (filePath) => ({
    scheme: 'file',
    fsPath: filePath,
    toString: () => `file://${filePath}`,
  }),
  parse: (uriStr) => {
    const fsPath = uriStr.startsWith('file://') ? uriStr.slice(7) : uriStr;
    return {
      scheme: 'file',
      fsPath,
      toString: () => uriStr,
    };
  },
};

module.exports = {
  Position,
  Range,
  DiagnosticSeverity,
  Diagnostic,
  CodeActionKind,
  CodeAction,
  WorkspaceEdit,
  workspace,
  languages,
  window,
  commands,
  Uri,
};
