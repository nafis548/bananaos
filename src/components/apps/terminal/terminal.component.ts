import { ChangeDetectionStrategy, Component, ElementRef, ViewChild, signal, inject, DestroyRef, effect, computed, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { GoogleGenAI } from '@google/genai';
import { NotificationService } from '../../../services/notification.service';
import { OsInteractionService } from '../../../services/os-interaction.service';
import { ApiKeyService } from '../../../services/api-key.service';
import { FileSystemNode, FileSystemService } from '../../../services/file-system.service';
import { IpService } from '../../../services/ip.service';

interface TerminalLine {
  type: 'command' | 'response';
  html: string;
  isThinking?: boolean;
}

@Component({
  selector: 'app-terminal',
  standalone: true,
  templateUrl: './terminal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
})
export class TerminalComponent implements OnInit {
  lines = signal<TerminalLine[]>([
    { type: 'response', html: "Welcome to Banana OS Terminal. Type 'help' for commands." }
  ]);
  
  @ViewChild('input') inputEl!: ElementRef<HTMLInputElement>;
  @ViewChild('output') outputEl!: ElementRef<HTMLDivElement>;

  private notificationService = inject(NotificationService);
  private osInteraction = inject(OsInteractionService);
  private apiKeyService = inject(ApiKeyService);
  private fsService = inject(FileSystemService);
  private ipService = inject(IpService);
  private destroyRef = inject(DestroyRef);
  private ai: GoogleGenAI | null = null;
  
  private startTime = Date.now();
  private cwd = signal<string>('/');
  private history: string[] = [];
  private historyIndex = -1;

  prompt = computed(() => {
    const path = this.cwd() === '/' ? '~' : this.cwd().split('/').pop();
    return `user@banana:${path}$`;
  });

  private fortunes = [
    "You will be hungry again in one hour.",
    "The fortune you seek is in another cookie.",
    "A conclusion is simply the place where you got tired of thinking.",
    "He who laughs last is laughing at you.",
    "If you think nobody cares, try missing a couple of payments.",
    "An alien of some sort will be appearing to you shortly."
  ];
  
  constructor() {
    effect(() => {
      const apiKey = this.apiKeyService.apiKey();
      if (apiKey) {
        this.ai = new GoogleGenAI({ apiKey });
      } else {
        this.ai = null;
      }
    });

    this.osInteraction.inAppActionRequest
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(action => {
        if (action.appId === 'terminal' && action.action === 'executeTerminalCommand') {
          this.runCommand(action.payload.command);
        }
      });
  }

  ngOnInit() {
    // Used for uptime command
    this.startTime = Date.now();
  }
  
  handleKeydown(event: KeyboardEvent) {
    const input = event.target as HTMLInputElement;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (this.history.length === 0) return;
      if (this.historyIndex === -1) this.historyIndex = this.history.length -1;
      else if (this.historyIndex > 0) this.historyIndex--;
      
      input.value = this.history[this.historyIndex];
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (this.historyIndex === -1 || this.historyIndex >= this.history.length - 1) {
        this.historyIndex = this.history.length;
        input.value = '';
      } else {
        this.historyIndex++;
        input.value = this.history[this.historyIndex];
      }
    }
  }

  async processCommand(event: Event) {
    const inputEl = event.target as HTMLInputElement;
    const command = inputEl.value;
    if (!command) return;
    
    if (this.history.length === 0 || this.history[this.history.length - 1] !== command) {
        this.history.push(command);
    }
    this.historyIndex = this.history.length;
    
    inputEl.value = '';

    await this.runCommand(command);
  }

  private parsePipesAndRedirection(command: string): { commands: string[], redirectTo: string | null } {
    let redirectTo: string | null = null;
    let mainCommand = command;

    if (command.includes('>')) {
        const parts = command.split('>');
        mainCommand = parts[0].trim();
        redirectTo = parts.slice(1).join('>').trim();
    }
    
    const commands = mainCommand.split('|').map(c => c.trim());

    return { commands, redirectTo };
  }
  
  async runCommand(command: string) {
    this.lines.update(current => [...current, { type: 'command', html: this.escapeHtml(command) }]);
    this.scrollToBottom();

    // The 'ai' command is special and doesn't support piping/redirection yet.
    if (command.trim().toLowerCase().startsWith('ai ')) {
        const prompt = command.trim().substring(3);
        await this.runAiCommand(prompt);
        this.scrollToBottom();
        return;
    }

    const { commands, redirectTo } = this.parsePipesAndRedirection(command);

    let stdin = '';
    let lastOutput = '';

    for (let i = 0; i < commands.length; i++) {
      const [cmd, ...args] = commands[i].trim().split(' ');
      
      // Handle 'clear' as a special case that stops execution.
      if (cmd.toLowerCase() === 'clear') {
          this.lines.set([]);
          return;
      }
      
      lastOutput = await this.executeSingleCommand(cmd, args, stdin);
      stdin = lastOutput; // Output of this command is input for the next.
    }

    if (redirectTo) {
      const filePath = this.resolvePath(redirectTo);
      const success = this.fsService.writeFile(filePath, this.stripHtml(lastOutput));
      if (!success) {
          const node = this.fsService.getNode(filePath);
          let errorMsg = `Could not write to ${redirectTo}.`;
          if (node?.type === 'directory') errorMsg = `${redirectTo} is a directory.`;
          else if (!this.fsService.getDirectory(filePath.substring(0, filePath.lastIndexOf('/')))) errorMsg = `Directory does not exist.`;

          this.lines.update(l => [...l, { type: 'response', html: `<span class="text-red-400">${errorMsg}</span>` }]);
      }
    } else if (lastOutput) {
      this.lines.update(current => [...current, { type: 'response', html: lastOutput }]);
    }

    this.scrollToBottom();
  }

  private async runAiCommand(prompt: string) {
      if (!this.ai) {
          const errorMessage = 'AI is not configured. Go to Settings > API Keys to add your Gemini API key.';
          this.notificationService.show({ appId: 'terminal', title: 'Terminal', body: errorMessage, type: 'error' });
          this.lines.update(l => [...l, { type: 'response', html: `<span class="text-red-400">Error: ${errorMessage}</span>`}]);
          return;
      }
      
      if (!prompt) {
          this.lines.update(l => [...l, { type: 'response', html: 'Please provide a prompt for the AI. Usage: ai "your question"'}]);
          return;
      }

      this.lines.update(current => [...current, { type: 'response', html: '', isThinking: true }]);
      this.scrollToBottom();
      
      try {
          const stream = await this.ai.models.generateContentStream({
              model: 'gemini-2.5-flash',
              contents: prompt,
          });

          let firstChunk = true;
          for await (const chunk of stream) {
              const text = chunk.text;
              this.lines.update(current => {
                  const newLines = [...current];
                  const lastLine = newLines[newLines.length - 1];
                  if (lastLine) {
                      if (firstChunk && lastLine.isThinking) {
                          lastLine.html = this.escapeHtml(text);
                          delete lastLine.isThinking;
                          firstChunk = false;
                      } else {
                          lastLine.html += this.escapeHtml(text);
                      }
                  }
                  return newLines;
              });
              this.scrollToBottom();
          }
      } catch (e) {
          console.error(e);
          const errorMsg = 'Error: Could not get a response from the AI.';
          this.notificationService.show({ appId: 'terminal', title: 'Terminal', body: errorMsg, type: 'error' });
          this.lines.update(current => {
              const newLines = [...current];
              const lastLine = newLines[newLines.length - 1];
              if (lastLine?.isThinking) {
                 lastLine.html = `<span class="text-red-400">${errorMsg}</span>`;
                 delete lastLine.isThinking;
              } else {
                 newLines.push({ type: 'response', html: `<span class="text-red-400">${errorMsg}</span>` });
              }
              return newLines;
          });
      }
  }

  private scrollToBottom() {
      setTimeout(() => {
        if (this.outputEl) {
            this.outputEl.nativeElement.scrollTop = this.outputEl.nativeElement.scrollHeight;
        }
    });
  }
  
  private resolvePath(path: string): string {
    if (!path || path === '.') return this.cwd();
    if (path.startsWith('/')) return this.fsService.normalizePath(path);

    const currentParts = this.cwd().split('/').filter(p => p);
    const newParts = path.split('/').filter(p => p);

    for (const part of newParts) {
        if (part === '..') {
            currentParts.pop();
        } else if (part !== '.') {
            currentParts.push(part);
        }
    }
    return '/' + currentParts.join('/');
  }

  private async executeSingleCommand(cmd: string, args: string[], stdin: string): Promise<string> {
    switch (cmd.toLowerCase()) {
      case 'help':
        return `Available commands: help, clear, date, echo, neofetch, ai, pwd, ls, cd, cat, mkdir, touch, rm, mv, cp, open, history, uname, whoami, uptime, grep, wc, ping, ipconfig, cowsay, fortune`;
      case 'date':
        return new Date().toString();
      case 'echo':
        return this.escapeHtml(args.join(' '));
      case 'neofetch':
        return `<pre class="whitespace-pre">
🍌 Banana OS v1.0
-----------------
OS: Banana OS (Angular)
Kernel: Web Browser
Resolution: ${window.innerWidth}x${window.innerHeight}
Theme: Dark
</pre>`;
      case 'pwd':
        return this.cwd();
      case 'cd':
        const targetPath = this.resolvePath(args[0] || '/');
        const dir = this.fsService.getDirectory(targetPath);
        if (dir) {
          this.cwd.set(targetPath);
          return '';
        } else {
          return `<span class="text-red-400">cd: no such file or directory: ${args[0]}</span>`;
        }
      case 'ls':
        const lsPath = this.resolvePath(args[0] || this.cwd());
        const lsDir = this.fsService.getDirectory(lsPath);
        if (lsDir) {
            const content = Object.values(lsDir.children);
            if (content.length === 0) return '';
            return content.map((node: FileSystemNode) => 
                node.type === 'directory' 
                    ? `<span class="text-blue-400">${node.name}</span>` 
                    : `<span>${node.name}</span>`
            ).join('\n');
        } else {
            return `<span class="text-red-400">ls: cannot access '${args[0] || '.'}': No such file or directory</span>`;
        }
      case 'cat':
        if (!args[0]) return 'usage: cat [file]';
        const catPath = this.resolvePath(args[0]);
        const fileContent = this.fsService.readFile(catPath);
        if (fileContent !== null) {
          return `<pre class="whitespace-pre-wrap">${this.escapeHtml(fileContent)}</pre>`;
        } else {
          const node = this.fsService.getNode(catPath);
          if (node?.type === 'directory') {
            return `<span class="text-red-400">cat: ${args[0]}: Is a directory</span>`;
          }
          return `<span class="text-red-400">cat: ${args[0]}: No such file or directory</span>`;
        }
      case 'mkdir':
        if (!args[0]) return 'usage: mkdir [directory_name]';
        const newDirPath = this.resolvePath(args[0]);
        const parentPath = newDirPath.substring(0, newDirPath.lastIndexOf('/')) || '/';
        const dirName = newDirPath.substring(newDirPath.lastIndexOf('/') + 1);
        if (this.fsService.createDirectory(parentPath, dirName)) return '';
        return `<span class="text-red-400">mkdir: cannot create directory ‘${args[0]}’: File exists</span>`;
      case 'touch':
        if (!args[0]) return 'usage: touch [file_name]';
        const newFilePath = this.resolvePath(args[0]);
        const parentFilePath = newFilePath.substring(0, newFilePath.lastIndexOf('/')) || '/';
        const fileName = newFilePath.substring(newFilePath.lastIndexOf('/') + 1);
        if (this.fsService.createFile(parentFilePath, fileName)) return '';
        return `<span class="text-red-400">touch: cannot create file ‘${args[0]}’: File exists</span>`;
      case 'rm':
        if (!args[0]) return 'usage: rm [file_or_directory]';
        const rmPath = this.resolvePath(args[0]);
        if (this.fsService.deleteNode(rmPath)) return '';
        return `<span class="text-red-400">rm: cannot remove '${args[0]}': No such file or directory</span>`;
      case 'mv':
        if (args.length < 2) return 'usage: mv [source] [destination]';
        const mvSource = this.resolvePath(args[0]);
        const mvDest = this.resolvePath(args[1]);
        if (this.fsService.moveNode(mvSource, mvDest)) return '';
        return `<span class="text-red-400">mv: failed to move '${args[0]}' to '${args[1]}'</span>`;
      case 'cp':
        if (args.length < 2) return 'usage: cp [source] [destination]';
        const cpSource = this.resolvePath(args[0]);
        const cpDest = this.resolvePath(args[1]);
        if (this.fsService.copyNode(cpSource, cpDest)) return '';
        return `<span class="text-red-400">cp: failed to copy '${args[0]}' to '${args[1]}'</span>`;
      case 'open':
          if (!args[0]) return 'usage: open [app_id | file_path]';
          const openPath = this.resolvePath(args[0]);
          const nodeToOpen = this.fsService.getNode(openPath);
          if (nodeToOpen) {
            if (nodeToOpen.type === 'directory') {
              this.osInteraction.openAppRequest.next({ appId: 'file-explorer', data: { path: nodeToOpen.path } });
            } else {
              const extension = nodeToOpen.name.split('.').pop()?.toLowerCase();
              let appId: string | null = null;
              switch(extension) {
                case 'txt': case 'md': case 'js': case 'ts': case 'json': case 'html': case 'css':
                  appId = 'text-editor';
                  break;
                case 'jpg': case 'jpeg': case 'png': case 'gif':
                  appId = 'photo-viewer';
                  break;
              }
              if (appId) {
                this.osInteraction.openAppRequest.next({ appId, data: { filePath: nodeToOpen.path } });
              } else {
                return `<span class="text-red-400">open: File type ".${extension}" is not supported.</span>`;
              }
            }
          } else {
            this.osInteraction.openAppRequest.next({ appId: args[0] });
          }
          return '';
      case 'history':
          return this.history.map((h, i) => `${i + 1}  ${this.escapeHtml(h)}`).join('\n');
      case 'uname':
          return 'BananaOS (Web)';
      case 'whoami':
          return 'user';
      case 'uptime':
          const uptime = Math.floor((Date.now() - this.startTime) / 1000);
          const days = Math.floor(uptime / 86400);
          const hours = Math.floor((uptime % 86400) / 3600);
          const minutes = Math.floor((uptime % 3600) / 60);
          return `up ${days} day(s), ${hours} hour(s), ${minutes} minute(s)`;
      case 'grep':
          if (!args[0]) return 'usage: grep [pattern] [file?]';
          const pattern = args[0];
          let textToSearch = stdin;
          if (!stdin && args[1]) {
              const grepPath = this.resolvePath(args[1]);
              textToSearch = this.fsService.readFile(grepPath) || '';
          }
          if (!textToSearch) return '';
          const regex = new RegExp(pattern, 'g');
          return textToSearch.split('\n').filter(line => line.match(regex)).map(line => {
            return this.escapeHtml(line).replace(regex, `<span class="bg-yellow-400 text-black">$&</span>`);
          }).join('\n');
      case 'wc':
          const textToCount = stdin || (args[0] ? this.fsService.readFile(this.resolvePath(args[0])) : null);
          if (textToCount === null) return `wc: ${args[0]}: No such file or directory`;
          const lineCount = textToCount.split('\n').length;
          const wordCount = textToCount.trim().split(/\s+/).filter(Boolean).length;
          const charCount = textToCount.length;
          return `${lineCount} ${wordCount} ${charCount}`;
      case 'ping':
          const host = args[0] || 'localhost';
          let pings = '';
          for(let i=0; i<4; i++) {
              await new Promise(res => setTimeout(res, 500));
              const ms = Math.floor(Math.random() * 30) + 1;
              pings += `Reply from ${this.escapeHtml(host)}: time=${ms}ms\n`;
          }
          return pings;
      case 'ipconfig':
          try {
            const ip = await new Promise<string>((res, rej) => this.ipService.getPublicIp().subscribe({ next: res, error: rej }));
            return `Public IP Address: ${ip}`;
          } catch {
            return 'Could not retrieve IP address.';
          }
      case 'cowsay':
        const message = args.join(' ') || stdin || 'Moo!';
        return this.cowsay(message);
      case 'fortune':
        return this.fortunes[Math.floor(Math.random() * this.fortunes.length)];
      default:
        return `<span class="text-red-400">Command not found: ${this.escapeHtml(cmd)}</span>`;
    }
  }

  private cowsay(message: string): string {
    const bubble = this.createSpeechBubble(message);
    const cow = `
        \\   ^__^
         \\  (oo)\\_______
            (__)\\       )\\/\\
                ||----w |
                ||     ||
    `;
    return `<pre class="whitespace-pre">${bubble}${cow}</pre>`;
  }

  private createSpeechBubble(text: string, maxWidth: number = 40): string {
    const lines = this.wordWrap(text, maxWidth);
    const top = ' ' + '_'.repeat(lines[0].length + 2) + ' \n';
    const bottom = ' ' + '-'.repeat(lines[0].length + 2) + ' \n';
    
    let middle = '';
    if (lines.length === 1) {
      middle = `< ${lines[0]} >\n`;
    } else {
      middle += `/ ${lines[0].padEnd(maxWidth)} \\\n`;
      for(let i = 1; i < lines.length -1; i++) {
        middle += `| ${lines[i].padEnd(maxWidth)} |\n`;
      }
      middle += `\\ ${lines[lines.length - 1].padEnd(maxWidth)} /\n`;
    }
    
    return top + middle + bottom;
  }
  
  private wordWrap(text: string, maxWidth: number): string[] {
    const lines: string[] = [];
    let currentLine = '';
    const words = text.split(' ');
    
    for (const word of words) {
      if ((currentLine + ' ' + word).length > maxWidth) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine += (currentLine ? ' ' : '') + word;
      }
    }
    lines.push(currentLine);
    
    const maxLineLength = Math.max(...lines.map(l => l.length));
    return lines.map(l => l.padEnd(maxLineLength));
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  private stripHtml(html: string): string {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return doc.body.textContent || "";
  }

  focusInput() {
    this.inputEl?.nativeElement.focus();
  }
}