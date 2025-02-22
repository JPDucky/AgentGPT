import axios from "axios";
import type { ModelSettings } from "../utils/types";
import { DEFAULT_MAX_LOOPS_FREE } from "../utils/constants";
import type { Session } from "next-auth";
import { v1, v4 } from "uuid";
import type { AgentMode, AgentPlaybackControl, Message, Task } from "../types/agentTypes";
import {
  AGENT_PAUSE,
  AGENT_PLAY,
  AUTOMATIC_MODE,
  MESSAGE_TYPE_GOAL,
  MESSAGE_TYPE_SYSTEM,
  MESSAGE_TYPE_TASK,
  MESSAGE_TYPE_THINKING,
  PAUSE_MODE,
  TASK_STATUS_COMPLETED,
  TASK_STATUS_EXECUTING,
  TASK_STATUS_FINAL,
  TASK_STATUS_STARTED,
} from "../types/agentTypes";
import { useAgentStore, useMessageStore } from "../stores";
import { translate } from "../utils/translations";
import type { Analysis } from "../services/agent-api";
import { AgentApi } from "../services/agent-api";

const TIMEOUT_LONG = 1000;
const TIMOUT_SHORT = 800;

class AutonomousAgent {
  name: string;
  goal: string;
  completedTasks: string[] = [];
  modelSettings: ModelSettings;
  isRunning = false;
  renderMessage: (message: Message) => void;
  handlePause: (opts: { agentPlaybackControl?: AgentPlaybackControl }) => void;
  shutdown: () => void;
  numLoops = 0;
  session?: Session;
  _id: string;
  mode: AgentMode;
  playbackControl: AgentPlaybackControl;
  $api: AgentApi;

  constructor(
    name: string,
    goal: string,
    renderMessage: (message: Message) => void,
    handlePause: (opts: { agentPlaybackControl?: AgentPlaybackControl }) => void,
    shutdown: () => void,
    modelSettings: ModelSettings,
    mode: AgentMode,
    session?: Session,
    playbackControl?: AgentPlaybackControl
  ) {
    this.name = name;
    this.goal = goal;
    this.renderMessage = renderMessage;
    this.handlePause = handlePause;
    this.shutdown = shutdown;
    this.modelSettings = modelSettings;
    this.session = session;
    this._id = v4();
    this.mode = mode || AUTOMATIC_MODE;
    this.playbackControl = playbackControl || this.mode == PAUSE_MODE ? AGENT_PAUSE : AGENT_PLAY;

    this.$api = new AgentApi(
      {
        goal,
        modelSettings,
      },
      this.onApiError
    );
  }

  async run() {
    if (!this.isRunning) {
      this.isRunning = true;
      await this.startGoal();
    }

    await this.loop();
    if (this.mode === PAUSE_MODE && !this.isRunning) {
      this.handlePause({ agentPlaybackControl: this.playbackControl });
    }
  }

  async startGoal() {
    this.sendGoalMessage();
    this.sendThinkingMessage();

    // Initialize by getting taskValues
    try {
      const taskValues = await this.$api.getInitialTasks();
      for (const value of taskValues) {
        await new Promise((r) => setTimeout(r, TIMOUT_SHORT));
        const task: Task = {
          taskId: v1().toString(),
          value,
          status: TASK_STATUS_STARTED,
          type: MESSAGE_TYPE_TASK,
        };
        this.sendMessage(task);
      }
    } catch (e) {
      console.log(e);
      this.sendErrorMessage(getMessageFromError(e));
      this.shutdown();
      return;
    }
  }

  async loop() {
    this.conditionalPause();

    if (!this.isRunning) {
      return;
    }

    if (this.getRemainingTasks().length === 0) {
      this.sendCompletedMessage();
      this.shutdown();
      return;
    }

    this.numLoops += 1;
    const maxLoops = this.maxLoops();
    if (this.numLoops > maxLoops) {
      this.sendLoopMessage();
      this.shutdown();
      return;
    }

    // Wait before starting
    await new Promise((r) => setTimeout(r, TIMEOUT_LONG));

    // Start with first task
    const currentTask = this.getRemainingTasks()[0] as Task;
    this.sendMessage({ ...currentTask, status: TASK_STATUS_EXECUTING });

    this.sendThinkingMessage();

    // Default to reasoning
    let analysis: Analysis = {
      reasoning: "I'll just think about it...",
      action: "reason",
      arg: "",
    };

    // If enabled, analyze what tool to use
    if (useAgentStore.getState().isWebSearchEnabled) {
      // Analyze how to execute a task: Reason, web search, other tools...
      analysis = await this.$api.analyzeTask(currentTask.value);
      this.sendAnalysisMessage(analysis);
    }

    const result = await this.$api.executeTask(currentTask.value, analysis);
    this.sendMessage({
      ...currentTask,
      info: result,
      status: TASK_STATUS_COMPLETED,
    });

    this.completedTasks.push(currentTask.value || "");

    // Wait before adding tasks
    await new Promise((r) => setTimeout(r, TIMEOUT_LONG));
    this.sendThinkingMessage();

    // Add new tasks
    try {
      const newTasks = await this.$api.getAdditionalTasks(
        {
          current: currentTask.value,
          remaining: this.getRemainingTasks().map((task) => task.value),
          completed: this.completedTasks,
        },
        result
      );
      for (const value of newTasks) {
        await new Promise((r) => setTimeout(r, TIMOUT_SHORT));
        const task: Task = {
          taskId: v1().toString(),
          value,
          status: TASK_STATUS_STARTED,
          type: MESSAGE_TYPE_TASK,
        };
        this.sendMessage(task);
      }

      if (newTasks.length == 0) {
        this.sendMessage({ ...currentTask, status: TASK_STATUS_FINAL });
      }
    } catch (e) {
      console.log(e);
      this.sendErrorMessage(translate("ERROR_ADDING_ADDITIONAL_TASKS", "errors"));

      this.sendMessage({ ...currentTask, status: TASK_STATUS_FINAL });
    }
    await this.loop();
  }

  getRemainingTasks(): Task[] {
    return useMessageStore.getState().tasks.filter((t: Task) => t.status === TASK_STATUS_STARTED);
  }

  private conditionalPause() {
    if (this.mode != PAUSE_MODE) {
      return;
    }

    // decide whether to pause agent when pause mode is enabled
    this.isRunning = !(this.playbackControl === AGENT_PAUSE);

    // reset playbackControl to pause so agent pauses on next set of task(s)
    if (this.playbackControl === AGENT_PLAY) {
      this.playbackControl = AGENT_PAUSE;
    }
  }

  private maxLoops() {
    return this.modelSettings.customMaxLoops || DEFAULT_MAX_LOOPS_FREE;
  }

  updatePlayBackControl(newPlaybackControl: AgentPlaybackControl) {
    this.playbackControl = newPlaybackControl;
  }

  updateIsRunning(isRunning: boolean) {
    this.isRunning = isRunning;
  }

  stopAgent() {
    this.sendManualShutdownMessage();
    this.isRunning = false;
    this.shutdown();
    return;
  }

  sendMessage(message: Message) {
    if (this.isRunning) {
      this.renderMessage(message);
    }
  }

  sendGoalMessage() {
    this.sendMessage({ type: MESSAGE_TYPE_GOAL, value: this.goal });
  }

  sendLoopMessage() {
    this.sendMessage({
      type: MESSAGE_TYPE_SYSTEM,
      value: translate("DEMO_LOOPS_REACHED", "errors"),
    });
  }

  sendManualShutdownMessage() {
    this.sendMessage({
      type: MESSAGE_TYPE_SYSTEM,
      value: translate("AGENT_MANUALLY_SHUT_DOWN", "errors"),
    });
  }

  sendCompletedMessage() {
    this.sendMessage({
      type: MESSAGE_TYPE_SYSTEM,
      value: translate("ALL_TASKS_COMPLETETD", "errors"),
    });
  }

  sendAnalysisMessage(analysis: Analysis) {
    // Hack to send message with generic test. Should use a different type in the future
    let message = "⏰ Generating response...";
    if (analysis.action == "search") {
      message = `🔍 Searching the web for "${analysis.arg}"...`;
    }
    if (analysis.action == "wikipedia") {
      message = `🌐 Searching Wikipedia for "${analysis.arg}"...`;
    }
    if (analysis.action == "image") {
      message = `🎨 Generating an image with prompt: "${analysis.arg}"...`;
    }
    if (analysis.action == "code") {
      message = `💻 Writing code...`;
    }

    this.sendMessage({
      type: MESSAGE_TYPE_SYSTEM,
      value: message,
    });
  }

  sendThinkingMessage() {
    this.sendMessage({ type: MESSAGE_TYPE_THINKING, value: "" });
  }

  sendErrorMessage(error: string) {
    this.sendMessage({ type: MESSAGE_TYPE_SYSTEM, value: error });
  }

  private onApiError = (e: unknown) => {
    this.shutdown();

    if (axios.isAxiosError(e) && e.response?.status === 429) {
      this.sendErrorMessage(translate("RATE_LIMIT_EXCEEDED", "errors"));
    }

    throw e;
  };
}

const getMessageFromError = (e: unknown) => {
  let message = "ERROR_RETRIEVE_INITIAL_TASKS";

  if (axios.isAxiosError(e)) {
    if (e.response?.status === 429) message = "ERROR_API_KEY_QUOTA";
    if (e.response?.status === 404) message = "ERROR_OPENAI_API_KEY_NO_GPT4";
    else message = "ERROR_ACCESSING_OPENAI_API_KEY";
  }

  return translate(message, "errors");
};

export default AutonomousAgent;
