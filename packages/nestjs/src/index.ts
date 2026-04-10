// @taskora/nestjs — NestJS integration for taskora.
//
// Skeleton entry. Public API lands in follow-up phases:
//   1. TaskoraCoreModule + Nest lifecycle (start/close wired to shutdown hooks)
//   2. forRoot / forRootAsync / forFeature + @InjectApp + TaskoraRef
//   3. @TaskConsumer explorer + @OnTaskEvent wiring
//   4. Class middleware + @InjectInspector / @InjectDeadLetters / @InjectSchedules
//   5. Board middleware mount + multi-app scoping
//   6. @taskora/nestjs/testing

export const VERSION = "0.0.0";
