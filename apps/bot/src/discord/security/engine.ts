import {
  evaluateNuke,
  evaluateRaid,
  evaluateSpam,
  type JoinSignal,
  type MessageSignal,
  type NukeSignal,
  type SecurityConfig,
  type SpamEvaluation,
  type RaidEvaluation,
  type NukeEvaluation,
} from './model';

const JOIN_RETENTION_MS = 60_000;
const NUKE_RETENTION_MS = 120_000;
const MESSAGE_RETENTION_MS = 60_000;
const MAX_JOIN_SIGNALS = 2_000;
const MAX_NUKE_SIGNALS = 1_000;
const MAX_MESSAGE_SIGNALS = 10_000;
const MAX_REJOIN_MARKERS = 10_000;
const RAID_RANK: Record<RaidEvaluation['level'], number> = {
  NORMAL: 0,
  WARNING: 1,
  RAID: 2,
  CRITICAL: 3,
};

/** In-memory rolling detector state; durable incidents/config live in DiscordRuntimeStore. */
export class SecurityEngine {
  private joins: JoinSignal[] = [];
  private actions: NukeSignal[] = [];
  private messages: MessageSignal[] = [];
  private readonly lastLeaves = new Map<string, number>();
  private lastRaidLevel: RaidEvaluation['level'] = 'NORMAL';

  public observeJoin(
    signal: JoinSignal,
    config: SecurityConfig,
  ): { readonly evaluation: RaidEvaluation; readonly transitioned: boolean } {
    this.joins = this.joins.filter(
      (join) => signal.at - join.at >= 0 && signal.at - join.at <= JOIN_RETENTION_MS,
    );
    for (const [userId, leftAt] of this.lastLeaves) {
      if (signal.at - leftAt > JOIN_RETENTION_MS || signal.at < leftAt)
        this.lastLeaves.delete(userId);
    }
    this.joins.push(signal);
    if (this.joins.length > MAX_JOIN_SIGNALS)
      this.joins.splice(0, this.joins.length - MAX_JOIN_SIGNALS);
    let evaluation = evaluateRaid(this.joins, signal.at, config);
    const leftAt = this.lastLeaves.get(signal.userId);
    if (
      leftAt !== undefined &&
      signal.at - leftAt <= JOIN_RETENTION_MS &&
      evaluation.level === 'NORMAL'
    ) {
      evaluation = {
        ...evaluation,
        level: 'WARNING',
        reasons: [...evaluation.reasons, 'member left and rejoined within 60 seconds'],
      };
    }
    this.lastLeaves.delete(signal.userId);
    const transitioned = RAID_RANK[evaluation.level] > RAID_RANK[this.lastRaidLevel];
    this.lastRaidLevel = evaluation.level;
    return { evaluation, transitioned };
  }

  public observeLeave(userId: string, at: number): void {
    this.lastLeaves.set(userId, at);
    if (this.lastLeaves.size > MAX_REJOIN_MARKERS) {
      const oldest = this.lastLeaves.keys().next().value;
      if (oldest !== undefined) this.lastLeaves.delete(oldest);
    }
  }

  public observeAction(signal: NukeSignal, actorIsTrusted: boolean): NukeEvaluation {
    this.actions = this.actions.filter(
      (action) => signal.at - action.at >= 0 && signal.at - action.at <= NUKE_RETENTION_MS,
    );
    this.actions.push(signal);
    if (this.actions.length > MAX_NUKE_SIGNALS)
      this.actions.splice(0, this.actions.length - MAX_NUKE_SIGNALS);
    return evaluateNuke(this.actions, signal, actorIsTrusted, signal.at);
  }

  public observeMessage(
    signal: MessageSignal,
    config: SecurityConfig,
    exempt: boolean,
  ): SpamEvaluation {
    this.messages = this.messages.filter(
      (message) => signal.at - message.at >= 0 && signal.at - message.at <= MESSAGE_RETENTION_MS,
    );
    const evaluation = evaluateSpam(this.messages, signal, config, exempt);
    this.messages.push(signal);
    if (this.messages.length > MAX_MESSAGE_SIGNALS)
      this.messages.splice(0, this.messages.length - MAX_MESSAGE_SIGNALS);
    return evaluation;
  }

  /** Evaluates the current join window without recording a join. */
  public currentRaid(config: SecurityConfig, now: number): RaidEvaluation {
    return evaluateRaid(this.joins, now, config);
  }

  public resetRaidLevel(): void {
    this.lastRaidLevel = 'NORMAL';
  }
}
