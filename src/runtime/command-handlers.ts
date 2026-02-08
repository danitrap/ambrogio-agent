import type { TelegramCommand } from "../telegram/commands";
import type { AgentRequestResult } from "./agent-request";

type UpdateContext = {
  updateId: number;
  userId: number;
  chatId: number;
};

export async function handleTelegramCommand(params: {
  command: TelegramCommand | null;
  update: UpdateContext;
  isAllowed: (userId: number) => boolean;
  sendCommandReply: (text: string) => Promise<void>;
  getStatusReply: () => string;
  getLastLogReply: () => string;
  getMemoryReply: (userId: number) => string;
  getSkillsReply: () => Promise<string>;
  getLastPrompt: (userId: number) => string | undefined;
  setLastPrompt: (userId: number, prompt: string) => void;
  clearConversation: (userId: number) => void;
  executePrompt: (prompt: string, command: string) => Promise<AgentRequestResult>;
  dispatchAssistantReply: (reply: string, options: { command: string; forceAudio?: boolean; noTtsPrefix?: string }) => Promise<void>;
  sendAudioFile: (inputPath: string) => Promise<string>;
  runHeartbeatNow: () => Promise<string | null>;
}): Promise<boolean> {
  const command = params.command;
  if (!command) {
    return false;
  }

  if (!params.isAllowed(params.update.userId)) {
    await params.sendCommandReply("Unauthorized user.");
    return true;
  }

  switch (command.name) {
    case "help": {
      await params.sendCommandReply(
        [
          "Comandi disponibili:",
          "/help - mostra questo aiuto",
          "/status - stato runtime agente",
          "/lastlog - ultimo riepilogo codex exec",
          "/retry - riesegue l'ultimo prompt utente",
          "/audio <prompt> - esegue il prompt e risponde in audio",
          "/memory - stato memoria conversazione",
          "/skills - lista skills disponibili",
          "/clear - cancella memoria conversazione",
          "/heartbeat - forza un heartbeat immediato",
          "/sendaudio <path> - invia un file audio da /data",
        ].join("\n"),
      );
      return true;
    }
    case "status":
      await params.sendCommandReply(params.getStatusReply());
      return true;
    case "lastlog":
      await params.sendCommandReply(params.getLastLogReply());
      return true;
    case "memory":
      await params.sendCommandReply(params.getMemoryReply(params.update.userId));
      return true;
    case "skills":
      await params.sendCommandReply(await params.getSkillsReply());
      return true;
    case "retry": {
      const lastPrompt = params.getLastPrompt(params.update.userId);
      if (!lastPrompt) {
        await params.sendCommandReply("Nessun prompt precedente da rieseguire.");
        return true;
      }
      const result = await params.executePrompt(lastPrompt, "retry");
      await params.dispatchAssistantReply(result.reply, { command: "retry" });
      return true;
    }
    case "audio": {
      if (!command.args) {
        await params.sendCommandReply("Usage: /audio <prompt>");
        return true;
      }
      const result = await params.executePrompt(command.args, "audio");
      if (result.ok) {
        params.setLastPrompt(params.update.userId, command.args);
      }
      await params.dispatchAssistantReply(result.reply, {
        command: "audio",
        forceAudio: true,
        noTtsPrefix: "ELEVENLABS_API_KEY non configurata, invio testo:",
      });
      return true;
    }
    case "sendaudio": {
      try {
        const relativePath = await params.sendAudioFile(command.args);
        await params.sendCommandReply(`Audio inviato: ${relativePath}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await params.sendCommandReply(`Impossibile inviare audio: ${message}`);
      }
      return true;
    }
    case "heartbeat":
      {
        const reply = await params.runHeartbeatNow();
        if (reply) {
          await params.sendCommandReply(reply);
        }
      }
      return true;
    case "clear":
      params.clearConversation(params.update.userId);
      await params.sendCommandReply("Memoria conversazione cancellata.");
      return true;
    default:
      await params.sendCommandReply(`Comando non riconosciuto: /${command.name}. Usa /help.`);
      return true;
  }
}
