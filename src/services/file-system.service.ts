import { Injectable, signal, effect } from '@angular/core';

const FS_LOCAL_STORAGE_KEY = 'banana-os-filesystem';

export interface FileSystemFile {
  name: string;
  path: string;
  type: 'file';
  content: string;
  size: number; // in bytes
  modifiedDate: number; // timestamp
}

export interface FileSystemDirectory {
  name: string;
  path: string;
  type: 'directory';
  children: { [name: string]: FileSystemNode };
  size: number; // always 0 for dirs for simplicity
  modifiedDate: number; // timestamp
}

export type FileSystemNode = FileSystemFile | FileSystemDirectory;

// --- SOURCE CODE FOR VIRTUAL FILE SYSTEM ---

const defaultImageBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAHhJREFUeJzt0DEBAAAAwqD1T20ND6AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8AAn2AAB2G1p5AAAAABJRU5ErkJggg==';
const welcomeContent = 'Welcome to the Banana OS Text Editor!';
const now = Date.now();

// Helper to calculate base64 size
const calculateBase64Size = (b64: string) => Math.ceil(b64.length / 4) * 3;

// Explicitly typed constants to help the compiler with the complex initial object.
const welcomeFile: FileSystemFile = {
  name: 'welcome.txt',
  path: '/Documents/welcome.txt',
  type: 'file',
  content: welcomeContent,
  size: welcomeContent.length,
  modifiedDate: now - 200000
};

const photoFile: FileSystemFile = {
  name: 'photo.png',
  path: '/Documents/photo.png',
  type: 'file',
  content: defaultImageBase64,
  size: calculateBase64Size(defaultImageBase64),
  modifiedDate: now - 500000
};

const kernelFile: FileSystemFile = {
  name: 'kernel.bin',
  path: '/System/kernel.bin',
  type: 'file',
  content: 'BINARY_DATA',
  size: 4096,
  modifiedDate: now - 8000000
};

const configFile: FileSystemFile = {
  name: 'config.sys',
  path: '/System/config.sys',
  type: 'file',
  content: 'CONFIG_DATA',
  size: 1024,
  modifiedDate: now - 7000000
};

const initialFileSystem: FileSystemDirectory = {
  name: '',
  path: '/',
  type: 'directory',
  children: {
    'Desktop': { name: 'Desktop', path: '/Desktop', type: 'directory', children: {}, size: 0, modifiedDate: now - 9000000 },
    'Documents': {
      name: 'Documents', path: '/Documents', type: 'directory',
      children: {
        'welcome.txt': welcomeFile,
        'photo.png': photoFile,
      },
      size: 0,
      modifiedDate: now - 500000
    },
    'Downloads': { name: 'Downloads', path: '/Downloads', type: 'directory', children: {}, size: 0, modifiedDate: now - 8500000 },
    'System': {
      name: 'System', path: '/System', type: 'directory',
      children: {
        'kernel.bin': kernelFile,
        'config.sys': configFile,
      },
      size: 0,
      modifiedDate: now - 9500000
    }
  },
  size: 0,
  modifiedDate: now - 10000000
};

@Injectable({ providedIn: 'root' })
export class FileSystemService {
  private fileSystem = signal<FileSystemDirectory>(this.loadFromLocalStorage());
  isCorrupted = signal(false);

  constructor() {
    effect(() => {
      localStorage.setItem(FS_LOCAL_STORAGE_KEY, JSON.stringify(this.fileSystem()));
    });
  }
  
  private calculateSize(content: string): number {
      if (content.startsWith('data:image')) {
          return calculateBase64Size(content);
      }
      return content.length; // Simple approximation for text
  }

  resetToDefaults() {
    this.fileSystem.set(initialFileSystem);
    this.isCorrupted.set(false);
  }
  
  private loadFromLocalStorage(): FileSystemDirectory {
    try {
      const savedFS = localStorage.getItem(FS_LOCAL_STORAGE_KEY);
      return savedFS ? JSON.parse(savedFS) : initialFileSystem;
    } catch {
      return initialFileSystem;
    }
  }
  
  private updateNodeByPath<T extends FileSystemNode>(path: string, updateFn: (node: T) => void): boolean {
      if (path.startsWith('/System/')) {
        this.isCorrupted.set(true);
        return false;
      }
      
      const parts = path.split('/').filter(p => p);
      if (parts.length === 0 && path !== '/') { // Cannot update root this way, but allow root update for specific cases
          return false;
      }

      this.fileSystem.update(fs => {
          const newFs = JSON.parse(JSON.stringify(fs));
          let currentNode: FileSystemDirectory = newFs;
          
          if (path === '/') {
              updateFn(currentNode as T);
              return newFs;
          }

          for (let i = 0; i < parts.length - 1; i++) {
              const nextNode = currentNode.children[parts[i]];
              if (nextNode && nextNode.type === 'directory') {
                  currentNode = nextNode;
              } else {
                  return fs; // Path not found, return original state
              }
          }
          const targetNode = currentNode.children[parts[parts.length - 1]];
          if (targetNode) {
              updateFn(targetNode as T);
          }
          return newFs;
      });
      return true;
  }


  getNode(path: string): FileSystemNode | null {
    if (path === '/') return this.fileSystem();
    const parts = path.split('/').filter(p => p);
    let currentNode: FileSystemNode = this.fileSystem();
    for (const part of parts) {
      if (currentNode.type === 'directory') {
        const child = currentNode.children[part];
        if (child) {
          currentNode = child;
        } else {
          return null;
        }
      } else {
        return null;
      }
    }
    return currentNode;
  }

  getDirectory(path: string): FileSystemDirectory | null {
    const node = this.getNode(path);
    return node?.type === 'directory' ? node : null;
  }

  readFile(path: string): string | null {
    const node = this.getNode(path);
    return node?.type === 'file' ? node.content : null;
  }

  writeFile(path: string, content: string): boolean {
    if (path.startsWith('/System/')) {
        this.isCorrupted.set(true);
        return false;
    }
    return this.updateNodeByPath<FileSystemFile>(path, (file) => {
        file.content = content;
        file.size = this.calculateSize(content);
        file.modifiedDate = Date.now();
    });
  }
  
  createDirectory(parentPath: string, dirName: string): boolean {
    const parentDir = this.getDirectory(parentPath);
    if (!parentDir || parentDir.children[dirName]) {
      return false;
    }
    return this.updateNodeByPath<FileSystemDirectory>(parentPath, (dir) => {
      dir.children[dirName] = {
          name: dirName,
          path: `${parentPath === '/' ? '' : parentPath}/${dirName}`,
          type: 'directory',
          children: {},
          size: 0,
          modifiedDate: Date.now()
      };
      dir.modifiedDate = Date.now();
    });
  }
  
  createFile(parentPath: string, fileName: string, content: string = ''): boolean {
    const parentDir = this.getDirectory(parentPath);
    if (!parentDir || parentDir.children[fileName]) {
        return false;
    }
    return this.updateNodeByPath<FileSystemDirectory>(parentPath, (dir) => {
      dir.children[fileName] = {
          name: fileName,
          path: `${parentPath === '/' ? '' : parentPath}/${fileName}`,
          type: 'file',
          content: content,
          size: this.calculateSize(content),
          modifiedDate: Date.now()
      };
      dir.modifiedDate = Date.now();
    });
  }
  
  deleteNode(path: string): boolean {
      if (path.startsWith('/System/')) {
        this.isCorrupted.set(true);
        return false;
      }
      const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
      const nodeName = path.substring(path.lastIndexOf('/') + 1);
      
      const parentDir = this.getDirectory(parentPath);
      if (!parentDir || !parentDir.children[nodeName]) return false;

      return this.updateNodeByPath<FileSystemDirectory>(parentPath, (dir) => {
          delete dir.children[nodeName];
          dir.modifiedDate = Date.now();
      });
  }
  
  renameNode(path: string, newName: string): boolean {
    if (path.startsWith('/System/')) {
        this.isCorrupted.set(true);
        return false;
    }
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    const oldName = path.substring(path.lastIndexOf('/') + 1);

    const parentDir = this.getDirectory(parentPath);
    if (!parentDir || !parentDir.children[oldName] || parentDir.children[newName]) {
        return false;
    }

    return this.updateNodeByPath<FileSystemDirectory>(parentPath, (dir) => {
        const nodeToRename = dir.children[oldName];
        nodeToRename.name = newName;
        nodeToRename.path = `${parentPath === '/' ? '' : parentPath}/${newName}`;
        nodeToRename.modifiedDate = Date.now();
        
        if (nodeToRename.type === 'directory') {
            this.updateChildrenPaths(nodeToRename, nodeToRename.path);
        }
        
        dir.children[newName] = nodeToRename;
        delete dir.children[oldName];
        dir.modifiedDate = Date.now();
    });
  }

  moveNode(sourcePath: string, newParentPath: string): boolean {
    const nodeToMove = this.getNode(sourcePath);
    const newParent = this.getDirectory(newParentPath);

    if (!nodeToMove || !newParent || newParent.children[nodeToMove.name] || sourcePath.startsWith('/System/')) {
        return false;
    }

    if (nodeToMove.type === 'directory' && newParentPath.startsWith(nodeToMove.path)) {
        return false;
    }

    const oldParentPath = sourcePath.substring(0, sourcePath.lastIndexOf('/')) || '/';
    if (oldParentPath === newParentPath) return false;

    this.fileSystem.update(fs => {
        const newFs = JSON.parse(JSON.stringify(fs));
        
        let oldParent: FileSystemDirectory = newFs;
        oldParentPath.split('/').filter(p => p).forEach(part => {
          oldParent = oldParent.children[part] as FileSystemDirectory
        });
        
        const nodeName = sourcePath.substring(sourcePath.lastIndexOf('/') + 1);
        const nodeCopy = oldParent.children[nodeName];
        if (!nodeCopy) return fs;
        delete oldParent.children[nodeName];

        let newParentDir: FileSystemDirectory = newFs;
        newParentPath.split('/').filter(p => p).forEach(part => {
          newParentDir = newParentDir.children[part] as FileSystemDirectory
        });

        this.updateChildrenPaths(nodeCopy, newParentPath);
        newParentDir.children[nodeCopy.name] = nodeCopy;
        
        return newFs;
    });

    return true;
  }

  copyNode(sourcePath: string, destinationParentPath: string): boolean {
    const sourceNode = this.getNode(sourcePath);
    const destinationDir = this.getDirectory(destinationParentPath);

    if (!sourceNode || !destinationDir) return false;

    let newName = sourceNode.name;
    let counter = 1;
    while (destinationDir.children[newName]) {
        const parts = sourceNode.name.split('.');
        const ext = parts.length > 1 ? '.' + parts.pop() : '';
        const base = parts.join('.');
        newName = `${base} (copy${counter > 1 ? ' ' + counter : ''})${ext}`;
        counter++;
    }

    if (sourceNode.type === 'directory' && destinationParentPath.startsWith(sourcePath)) {
        return false;
    }

    this.fileSystem.update(fs => {
      const newFs = JSON.parse(JSON.stringify(fs));
      const nodeCopy = JSON.parse(JSON.stringify(sourceNode));
      nodeCopy.name = newName;

      this.updateChildrenPaths(nodeCopy, destinationParentPath);
      
      let targetDir: FileSystemDirectory = newFs;
      destinationParentPath.split('/').filter(p => p).forEach(part => {
          if (targetDir.children[part]?.type === 'directory') {
              targetDir = targetDir.children[part] as FileSystemDirectory;
          }
      });
      targetDir.children[nodeCopy.name] = nodeCopy;
      return newFs;
    });

    return true;
  }

  private updateChildrenPaths(dir: FileSystemNode, parentPath: string) {
      dir.path = `${parentPath === '/' ? '' : parentPath}/${dir.name}`;
      dir.modifiedDate = Date.now();
      if (dir.type === 'directory') {
          for (const childName in dir.children) {
              this.updateChildrenPaths(dir.children[childName], dir.path);
          }
      }
  }

  corruptFileSystem() {
    this.fileSystem.update(fs => {
      const corruptedFs = JSON.parse(JSON.stringify(fs));
      const gibberish = () => Math.random().toString(36).substring(2, 7);

      const traverseAndCorrupt = (dir: FileSystemDirectory) => {
        for (const key in dir.children) {
          const node = dir.children[key];
          
          if (Math.random() < 0.5) { // 50% chance to corrupt
            if (node.type === 'file') {
              node.name = `${gibberish()}.dat`;
              node.content = `CORRUPTED_DATA_${gibberish()}`;
            } else {
              node.name = gibberish();
              traverseAndCorrupt(node);
            }
          }
          
          if (Math.random() < 0.2 && !['System', 'Desktop'].includes(key)) { // 20% chance to delete
            delete dir.children[key];
          }
        }
      };

      traverseAndCorrupt(corruptedFs);
      return corruptedFs;
    });
  }

  normalizePath(path: string): string {
    const parts = path.split('/').filter(p => p);
    const newParts: string[] = [];
    for (const part of parts) {
      if (part === '..') {
        newParts.pop();
      } else if (part !== '.') {
        newParts.push(part);
      }
    }
    return '/' + newParts.join('/');
  }
}