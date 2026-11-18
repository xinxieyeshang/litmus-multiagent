import { pgTable, serial, timestamp, varchar, integer, jsonb, boolean, index, text } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"


export const healthCheck = pgTable("health_check", {
	id: serial().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

// ============================================================================
// 后台任务表：存储批量处理任务状态
// ============================================================================
export const backgroundTasks = pgTable(
	"background_tasks",
	{
		id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
		signal_type: varchar("signal_type", { length: 20 }).notNull(), // 'signal1', 'signal2', 'signal3', 'signal4', 'all'
		status: varchar("status", { length: 20 }).notNull().default('pending'), // 'pending', 'running', 'completed', 'failed', 'cancelled'
		progress: integer("progress").notNull().default(0), // 0-100
		total_papers: integer("total_papers").notNull().default(0),
	 processed_papers: integer("processed_papers").notNull().default(0),
		batch_size: integer("batch_size").notNull().default(5),
		llm_model: varchar("llm_model", { length: 50 }),
		llm_temperature: varchar("llm_temperature", { length: 10 }),
		error_message: text("error_message"),
		paper_file_name: varchar("paper_file_name", { length: 100 }),
		h1_file_name: varchar("h1_file_name", { length: 100 }),
		created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		started_at: timestamp("started_at", { withTimezone: true }),
		completed_at: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		index("background_tasks_status_idx").on(table.status),
		index("background_tasks_signal_type_idx").on(table.signal_type),
		index("background_tasks_created_at_idx").on(table.created_at),
	]
);

// ============================================================================
// 任务结果表：存储每个论文的处理结果
// ============================================================================
export const taskResults = pgTable(
	"task_results",
	{
		id: serial().primaryKey(),
		task_id: varchar("task_id", { length: 36 }).notNull().references(() => backgroundTasks.id, { onDelete: "cascade" }),
		pmid: varchar("pmid", { length: 20 }).notNull(),
		signal_type: varchar("signal_type", { length: 20 }).notNull(),
		result_data: jsonb("result_data").notNull(), // 存储信号结果JSON
		score: integer("score"), // 归一化分数 0-100（存储为整数避免精度问题）
		created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("task_results_task_id_idx").on(table.task_id),
		index("task_results_pmid_idx").on(table.pmid),
		index("task_results_signal_type_idx").on(table.signal_type),
	]
);

// ============================================================================
// 论文数据缓存表：存储上传的论文数据
// ============================================================================
export const paperCache = pgTable(
	"paper_cache",
	{
		id: serial().primaryKey(),
		task_id: varchar("task_id", { length: 36 }).notNull().references(() => backgroundTasks.id, { onDelete: "cascade" }),
		pmid: varchar("pmid", { length: 20 }).notNull(),
		title: text("title"),
		abstract: text("abstract").notNull(),
		mesh_terms: jsonb("mesh_terms"), // string[]
		year: varchar("year", { length: 10 }),
		paper_type: varchar("paper_type", { length: 50 }),
		is_h1: boolean("is_h1").notNull().default(false),
		h1_classification: jsonb("h1_classification"), // string[]
		h1_rating: varchar("h1_rating", { length: 20 }),
		created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("paper_cache_task_id_idx").on(table.task_id),
		index("paper_cache_pmid_idx").on(table.pmid),
	]
);

// ============================================================================
// 任务指标表：存储计算后的指标结果
// ============================================================================
export const taskMetrics = pgTable(
	"task_metrics",
	{
		id: serial().primaryKey(),
		task_id: varchar("task_id", { length: 36 }).notNull().references(() => backgroundTasks.id, { onDelete: "cascade" }),
		signal_type: varchar("signal_type", { length: 20 }).notNull(),
		auc: integer("auc"), // AUC分数 x100（0-100）
		precision_at_k: jsonb("precision_at_k"), // {k: score}
		cohens_d: integer("cohens_d"), // Cohen's d x100
		h1_count: integer("h1_count").notNull().default(0),
		total_count: integer("total_count").notNull().default(0),
		created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("task_metrics_task_id_idx").on(table.task_id),
		index("task_metrics_signal_type_idx").on(table.signal_type),
	]
);