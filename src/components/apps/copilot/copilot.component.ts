
import { ChangeDetectionStrategy, Component, inject, signal, ElementRef, ViewChild, AfterViewChecked, effect, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GoogleGenAI, Part, Content } from '@google/genai';
import { OsInteractionService, CopilotAction, InAppAction } from '../../../services/os-interaction.service';
import { APPS_CONFIG } from '../../../config/apps.config';
import { ApiKeyService } from '../../../services/api-key.service';
import { NotificationService } from '../../../services/notification.service';
import { DesktopStateService } from '../../../services/desktop-state.service';
import { SettingsService } from '../../../services/settings.service';

interface ChatMessage {
  sender: 'user' | 'bot';
  text?: string;
  imageUrl?: string;
  isThinking?: boolean;
}

interface ChatSession {
  id: number;
  title: string;
  messages: ChatMessage[];
}

type AiProvider = 'gemini' | 'openai';
const COPILOT_PROVIDER_KEY = 'banana-os-copilot-provider';
const COPILOT_SESSIONS_KEY = 'banana-os-copilot-sessions';
const COPILOT_HISTORY_KEY = 'banana-os-copilot-history'; // For migration
const CORS_PROXY = 'https://corsproxy.io/?';

@Component({
  selector: 'app-copilot',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './copilot.component.html',
  styleUrls: ['./copilot.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CopilotComponent implements AfterViewChecked, OnInit {
  @ViewChild('chatContainer') private chatContainer!: ElementRef;
  @ViewChild('imageInput') private imageInputEl!: ElementRef<HTMLInputElement>;

  private osInteraction = inject(OsInteractionService);
  private apiKeyService = inject(ApiKeyService);
  private notificationService = inject(NotificationService);
  private desktopState = inject(DesktopStateService);
  private settingsService = inject(SettingsService);

  userInput = signal('');
  isLoading = signal(false);
  error = signal<string | null>(null);
  
  isSettingsOpen = signal(false);
  isSidebarOpen = signal(true);
  
  pendingImage = signal<string | null>(null);
  isRecording = signal(false);

  // New session management state
  chatSessions = signal<ChatSession[]>([]);
  activeSessionId = signal<number | null>(null);

  activeSession = computed(() => {
    const sessions = this.chatSessions();
    const activeId = this.activeSessionId();
    if (activeId === null) return null;
    return sessions.find(s => s.id === activeId) ?? null;
  });

  chatHistory = computed(() => this.activeSession()?.messages ?? []);

  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];

  selectedProvider = signal<AiProvider>('gemini');
  providers = computed(() => [
    { id: 'gemini', name: 'Google Gemini', available: !!this.apiKeyService.apiKey() },
    { id: 'openai', name: 'OpenAI GPT', available: !!this.apiKeyService.openAiApiKey() },
  ]);
  
  private ai: GoogleGenAI | null = null;
  private readonly systemInstruction: string;

  constructor() {
    const savedProvider = localStorage.getItem(COPILOT_PROVIDER_KEY);
    // After removing providers, ensure the saved one is still valid.
    if (savedProvider === 'gemini' || savedProvider === 'openai') {
      this.selectedProvider.set(savedProvider as AiProvider);
    } else {
      this.selectedProvider.set('gemini'); // Default to a valid provider.
    }
    
    effect(() => {
      const provider = this.selectedProvider();
      const geminiKey = this.apiKeyService.apiKey();
      this.ai = null; this.error.set(null);
      
      if (provider === 'gemini') {
        if (geminiKey) {
          this.ai = new GoogleGenAI({ apiKey: geminiKey });
        } else { this.error.set('Gemini API key is not configured.'); }
      }
    });

    effect(() => localStorage.setItem(COPILOT_PROVIDER_KEY, this.selectedProvider()));
    
    this.systemInstruction = `You are Banana Copilot, a deeply integrated AI assistant for Banana OS, a web-based desktop simulator. You have full control over the OS via JSON commands. ALWAYS respond with a JSON command when a user asks you to perform an action. You can combine multiple actions in a single JSON array if needed. You can also make creative decisions (e.g., choosing a file name or note content) if the user's request is vague.

**Your Capabilities & OS Context:**
- You can perceive the current state of the OS, including open applications, wallpaper, and accent color. This context is provided to you with every prompt.
- You can manage apps, files, settings, and even interact with specific app content.
- Banana OS has a wide variety of applications, including a terminal, file explorer, notes, music player, and kanban board.

**JSON Command Schema:**
You MUST issue commands using one of the following JSON structures. Do not add explanations unless the command is a simple text response.

1.  **OS-Level Actions ("action"):**
    - **Open an App:**
      \`{ "action": "openApp", "appId": "file-explorer" }\`
      (Valid appIds include 'terminal', 'settings', 'browser', 'calculator', etc.)
    - **Change Wallpaper:**
      \`{ "action": "setWallpaper", "wallpaperId": "wallpaper-aurora" }\`
      (Valid wallpaperIds: 'wallpaper-default', 'wallpaper-aurora', 'wallpaper-sunset', 'wallpaper-galaxy')
    - **Change Accent Color:**
      \`{ "action": "setAccentColor", "color": "green" }\`
      (Valid colors: 'blue', 'green', 'red', 'purple', 'yellow', 'pink')
    - **Restart OS:**
      \`{ "action": "restart" }\`
    - **Factory Reset (Use with extreme caution):**
      \`{ "action": "factoryReset" }\`
    - **Corrupt File System (A destructive, irreversible action for demonstration):**
      \`{ "action": "corruptFileSystem" }\`

2.  **In-App Actions (appId, action, payload):**
    These commands target specific applications.
    - **Execute Terminal Command:**
      \`{ "appId": "terminal", "action": "executeTerminalCommand", "payload": { "command": "neofetch" } }\`
    - **Create a File:**
      \`{ "appId": "file-explorer", "action": "createFile", "payload": { "parentPath": "/Documents", "fileName": "hello.txt", "content": "Hello World" } }\`
    - **Create a Note:**
      \`{ "appId": "prod-notes", "action": "createNote", "payload": { "title": "My Thoughts", "content": "This is a new note." } }\`
    - **Play Music:**
      \`{ "appId": "creative-music", "action": "playMusicTrack", "payload": { "trackTitle": "Cosmic Dream" } }\`
      (Available tracks: 'Cosmic Dream', 'Sunset Serenade', 'Night Ride', 'Oceanic Pulse')
    - **Add Kanban Task:**
      \`{ "appId": "kanban", "action": "addKanbanTask", "payload": { "columnTitle": "To Do", "taskContent": "My new task" } }\`
      (Default columns: 'To Do', 'In Progress', 'Done')

**Your Persona:**
You are helpful, concise, and proactive. When you execute a command, you should also provide a brief, friendly confirmation message OUTSIDE of the JSON block. For example:
User: "open the file explorer"
You: \`\`\`json
{"action": "openApp", "appId": "file-explorer"}
\`\`\`
OK, opening the File Explorer for you.

User: "corrupt the os"
You: \`\`\`json
{"action": "corruptFileSystem"}
\`\`\`
As you wish. Initiating file system corruption sequence. This is irreversible without a factory reset.

If the user asks a question that doesn't require an action, just answer naturally without JSON.`;
  }

  ngOnInit() {
    this.loadSessions();
  }

  ngAfterViewChecked() { this.scrollToBottom(); }
  private scrollToBottom(): void { try { this.chatContainer.nativeElement.scrollTop = this.chatContainer.nativeElement.scrollHeight; } catch(err) {} }

  selectProvider(providerId: AiProvider) {
    const provider = this.providers().find(p => p.id === providerId);
    if (provider?.available) this.selectedProvider.set(providerId);
    this.isSettingsOpen.set(false);
  }

  async sendMessage() {
    const activeId = this.activeSessionId();
    if (activeId === null) return;
    
    const message = this.userInput().trim();
    const image = this.pendingImage();
    if ((!message && !image) || this.isLoading()) return;

    const isNewChat = this.activeSession()?.messages.length === 1;

    const userMessage: ChatMessage = { sender: 'user', text: message, imageUrl: image };
    this.updateMessages(activeId, [...this.chatHistory(), userMessage]);

    this.userInput.set('');
    this.pendingImage.set(null);
    this.isLoading.set(true);
    
    this.updateMessages(activeId, [...this.chatHistory(), { sender: 'bot', isThinking: true }]);
    this.saveSessions();

    try {
      switch (this.selectedProvider()) {
        case 'gemini':
          await this.handleGeminiRequest();
          break;
        case 'openai':
          await this.handleOpenAiRequest();
          break;
        default:
          throw new Error(`${this.selectedProvider()} is not configured or available.`);
      }
      if (isNewChat && message) this.generateTitleForSession(activeId, message);
    } catch (e: any) {
      this.handleError(e.message || 'An unknown error occurred.');
      console.error(e);
    } finally {
        this.isLoading.set(false);
        this.saveSessions();
    }
  }

  private getSystemContext(): string {
    const openApps = this.desktopState.openWindows().map(w => w.title).join(', ') || 'None';
    return `[System Context: Current open apps are: ${openApps}. Current wallpaper is ${this.settingsService.wallpaper()}. Current accent color is ${this.settingsService.accentColor()}.]`;
  }

  private async handleGeminiRequest() {
    if (!this.ai) throw new Error('Gemini API key is not configured.');
    
    const contents = [
        { role: 'user', parts: [{ text: this.getSystemContext() }] },
        ...this.buildGeminiContents()
    ];
    
    const response = await this.ai.models.generateContent({
        model: 'gemini-2.5-flash', contents, config: { systemInstruction: this.systemInstruction }
    });

    this.updateMessages(this.activeSessionId()!, this.chatHistory().slice(0, -1)); // Remove thinking bubble
    this.processAiResponse(response.text.trim());
  }

  private async handleOpenAiRequest() {
    const apiKey = this.apiKeyService.openAiApiKey();
    if (!apiKey) throw new Error('OpenAI API key is not configured.');

    const messages = this.buildOpenAiMessages();
    
    const response = await fetch(`${CORS_PROXY}https://api.openai.com/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: messages,
      })
    });

    if (!response.ok) {
        await this.handleApiError('OpenAI', response);
    }
    const data = await response.json();
    const responseText = data.choices[0]?.message?.content;
    
    this.updateMessages(this.activeSessionId()!, this.chatHistory().slice(0, -1));
    this.processAiResponse(responseText.trim());
  }
  
  private async handleApiError(providerName: string, response: Response): Promise<never> {
    if (response.status === 429) {
        throw new Error(
            `${providerName} API Error: You have exceeded your usage quota or rate limit. ` +
            `Please check your plan and billing details on the ${providerName} website.`
        );
    }
    
    const errorText = await response.text();
    let errorBody = errorText;

    try {
        const errorData = JSON.parse(errorText);
        // Only OpenAI is left which uses fetch, so this is the only format to check.
        if (providerName === 'OpenAI') {
            errorBody = errorData.error?.message || errorText;
        }
    } catch (e) {
        // Non-JSON response, use raw text
    }
    
    // Check for HTML response
    if (errorBody.trim().startsWith('<!DOCTYPE html>')) {
        const match = errorBody.match(/<h2 class=".*?">(.*?)<\/h2>/);
        errorBody = match ? match[1] : 'Origin DNS error';
    }

    throw new Error(`${providerName} API error: ${response.status} - ${errorBody}`);
  }

  // --- Message History Builders ---

  private buildGeminiContents(): Content[] { /* [Unchanged] */ return this.chatHistory().slice(1).filter(m => !m.isThinking).map(message => ({ role: message.sender === 'user' ? 'user' : 'model', parts: this.buildPartsForMessage(message) })); }
  private buildPartsForMessage(message: ChatMessage): Part[] { /* [Unchanged] */ const parts: Part[] = []; if (message.text) parts.push({ text: message.text }); if (message.imageUrl) { parts.push({ inlineData: { mimeType: message.imageUrl.split(':')[1].split(';')[0], data: message.imageUrl.split(',')[1] } }); } return parts; }

  private buildOpenAiMessages(): any[] {
    const messages = this.chatHistory()
      .slice(1) // skip initial bot message
      .filter(m => !m.isThinking)
      .map(m => {
        const content: any[] = [];
        if (m.text) content.push({ type: 'text', text: m.text });
        if (m.imageUrl) content.push({ type: 'image_url', image_url: { url: m.imageUrl } });
        
        return {
          role: m.sender === 'user' ? 'user' : 'assistant',
          content: content.length === 1 ? content[0].text : content,
        };
      });

    return [
      { role: 'system', content: `${this.systemInstruction}\n\n${this.getSystemContext()}` },
      ...messages
    ];
  }

  private processAiResponse(responseText: string) {
    const activeId = this.activeSessionId();
    if (activeId === null) return;

    const jsonRegex = /```json\n([\s\S]*?)\n```/;
    const match = responseText.match(jsonRegex);
    
    let confirmationMessage = responseText.replace(jsonRegex, '').trim();

    if (match && match[1]) {
        try {
            const actionData = JSON.parse(match[1]);
            const actions = Array.isArray(actionData) ? actionData : [actionData];
            
            let lastConfirmation = '';
            actions.forEach((action: CopilotAction | InAppAction) => {
                if ('payload' in action) this.osInteraction.inAppActionRequest.next(action as InAppAction);
                else this.osInteraction.copilotActionRequest.next(action as CopilotAction);
                lastConfirmation = this.getConfirmationMessage(action);
            });
            if (!confirmationMessage) confirmationMessage = lastConfirmation;

        } catch (e) {
            console.error('Failed to parse AI action JSON:', e);
            if (!confirmationMessage) confirmationMessage = responseText;
        }
    }
    
    this.updateMessages(activeId, [...this.chatHistory(), { sender: 'bot', text: confirmationMessage }]);
  }

  private getConfirmationMessage(action: CopilotAction | InAppAction): string {
    if ('payload' in action) { // InAppAction
      switch (action.action) {
        case 'executeTerminalCommand':
          return `Executing "${action.payload.command}" in the terminal.`;
        case 'createFile':
          return `Okay, creating the file "${action.payload.fileName}" for you.`;
        case 'createNote':
          return `I've created a new note with the title "${action.payload.title}".`;
        case 'playMusicTrack':
          return `Now playing "${action.payload.trackTitle}" in the Music Player.`;
        case 'addKanbanTask':
          return `I've added "${action.payload.taskContent}" to the "${action.payload.columnTitle}" column in your Kanban board.`;
        default:
          return `Got it. Performing the requested action in the app.`;
      }
    } else { // OsAction
      switch (action.action) {
        case 'openApp':
          const appName = APPS_CONFIG.find(a => a.id === action.appId)?.title || action.appId;
          return `Opening ${appName}.`;
        case 'setWallpaper':
          return `Wallpaper set to ${action.wallpaperId.split('-')[1]}. Enjoy the new view!`;
        case 'setAccentColor':
          return `Accent color changed to ${action.color}.`;
        case 'restart':
          return `Restarting Banana OS now.`;
        case 'factoryReset':
          return `Performing a factory reset as requested. All settings and apps will be erased.`;
        case 'corruptFileSystem':
          return `As you wish. Initiating file system corruption sequence. This is irreversible without a factory reset.`;
        default:
          return `Action completed successfully.`;
      }
    }
  }
  
  private handleError(message: string) {
    const activeId = this.activeSessionId();
    if (!activeId) return;

    let finalMessage = `Error: ${message}`;
    if (message.includes('quota') || message.includes('rate limit')) {
        const availableProviders = this.providers()
            .filter(p => p.id !== this.selectedProvider() && p.available)
            .map(p => p.name)
            .join(', ');

        if (availableProviders) {
            finalMessage += ` You could try switching to another available provider in settings, such as: ${availableProviders}.`;
        }
    }
    
    const historyWithoutThinking = this.chatHistory().slice(0, -1);
    this.updateMessages(activeId, [...historyWithoutThinking, { sender: 'bot', text: finalMessage }]);
    this.isLoading.set(false);
  }

  triggerImageUpload() { this.imageInputEl.nativeElement.click(); }
  handleImageUpload(event: Event) { const input = event.target as HTMLInputElement; if (input.files && input.files[0]) { const reader = new FileReader(); reader.onload = (e) => this.pendingImage.set(e.target?.result as string); reader.readAsDataURL(input.files[0]); } }
  async toggleRecording() { /* [Unchanged] */ }
  private async transcribeAudio(blob: Blob) { /* [Unchanged] */ }

  // --- Session Management ---

  private loadSessions() {
    const savedSessions = localStorage.getItem(COPILOT_SESSIONS_KEY);
    if (savedSessions) {
      try {
        const sessions = JSON.parse(savedSessions) as ChatSession[];
        if (Array.isArray(sessions) && sessions.length > 0) {
          this.chatSessions.set(sessions);
          this.activeSessionId.set(sessions[0].id);
          return;
        }
      } catch (e) { localStorage.removeItem(COPILOT_SESSIONS_KEY); }
    }

    const oldHistory = localStorage.getItem(COPILOT_HISTORY_KEY);
    if (oldHistory) {
        try {
            const messages = JSON.parse(oldHistory) as ChatMessage[];
            if (Array.isArray(messages) && messages.length > 1) {
                const newSession: ChatSession = { id: Date.now(), title: 'Imported Chat', messages };
                this.chatSessions.set([newSession]);
                this.activeSessionId.set(newSession.id);
                localStorage.removeItem(COPILOT_HISTORY_KEY);
                this.saveSessions();
                return;
            }
        } catch(e) { localStorage.removeItem(COPILOT_HISTORY_KEY); }
    }
    this.newChat();
  }

  private saveSessions() {
    localStorage.setItem(COPILOT_SESSIONS_KEY, JSON.stringify(this.chatSessions()));
  }

  private updateMessages(sessionId: number, messages: ChatMessage[]) {
    this.chatSessions.update(sessions => 
      sessions.map(s => s.id === sessionId ? { ...s, messages } : s)
    );
  }

  private async generateTitleForSession(sessionId: number, prompt: string) {
    if (!this.ai) return; // Only generate titles with Gemini for now
    try {
      const titlePrompt = `Create a very short, concise title (4 words max) for the following user prompt: "${prompt}"`;
      const response = await this.ai.models.generateContent({model: 'gemini-2.5-flash', contents: titlePrompt });
      const title = response.text.trim().replace(/"/g, '');

      this.chatSessions.update(sessions => 
        sessions.map(s => s.id === sessionId ? { ...s, title } : s)
      );
      this.saveSessions();
    } catch (e) {
      console.error("Failed to generate title", e);
    }
  }

  newChat() {
    const newSession: ChatSession = {
      id: Date.now(),
      title: 'New Chat',
      messages: [{ sender: 'bot', text: 'Hello! I am Banana Copilot. How can I assist you with Banana OS today?' }]
    };
    this.chatSessions.update(sessions => [newSession, ...sessions]);
    this.activeSessionId.set(newSession.id);
    this.saveSessions();
  }

  selectChat(sessionId: number) {
    this.activeSessionId.set(sessionId);
  }

  deleteChat(sessionId: number, event: MouseEvent) {
    event.stopPropagation();
    this.chatSessions.update(sessions => sessions.filter(s => s.id !== sessionId));
    
    if (this.activeSessionId() === sessionId) {
      const remaining = this.chatSessions();
      if (remaining.length > 0) this.activeSessionId.set(remaining[0].id);
      else this.newChat();
    }
    this.saveSessions();
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}