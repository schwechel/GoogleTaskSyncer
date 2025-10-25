import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as core from '@actions/core';

interface Task {
  id: string;
  title: string;
  notes?: string;
  status: string;
  due?: string;
  completed?: string;
  updated: string;
  parent?: string;
  position?: string;
}

interface SyncState {
  tasks: {
    [taskId: string]: {
      accountAId: string;
      accountBId: string;
      lastSyncedUpdate: string;
    };
  };
  lastSyncTime: string;
}

interface TaskList {
  id: string;
  title: string;
}

class GoogleTasksSync {
  private clientA!: OAuth2Client;
  private clientB!: OAuth2Client;
  private tasksApiA: any;
  private tasksApiB: any;
  private syncState: SyncState;
  private stateFile: string;
  private readonly MAX_RETRIES = 5;
  private readonly INITIAL_DELAY_MS = 1000;

  constructor() {
    this.stateFile = path.join(process.cwd(), 'sync-state.json');
    this.syncState = { tasks: {}, lastSyncTime: new Date(0).toISOString() };
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    operationName: string,
    retries: number = this.MAX_RETRIES
  ): Promise<T> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        const isRateLimitError = 
          error.code === 429 || 
          error.message?.includes('Quota Exceeded') ||
          error.message?.includes('Rate Limit Exceeded') ||
          error.message?.includes('rateLimitExceeded');

        if (isRateLimitError && attempt < retries) {
          const delayMs = this.INITIAL_DELAY_MS * Math.pow(2, attempt);
          core.error(`Rate limit hit for ${operationName}. Retrying in ${delayMs}ms (attempt ${attempt + 1}/${retries})...`);
          await this.sleep(delayMs);
        } else if (attempt < retries && (error.code >= 500 || error.code === 'ECONNRESET')) {
          // Retry on server errors
          const delayMs = this.INITIAL_DELAY_MS * Math.pow(2, attempt);
          core.error(`Server error for ${operationName}. Retrying in ${delayMs}ms (attempt ${attempt + 1}/${retries})...`);
          await this.sleep(delayMs);
        } else {
          throw error;
        }
      }
    }
    throw new Error(`Failed after ${retries} retries`);
  }

  async initialize() {
    // Initialize OAuth clients for both accounts
    this.clientA = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'urn:ietf:wg:oauth:2.0:oob'
    );
    
    this.clientB = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'urn:ietf:wg:oauth:2.0:oob'
    );

    // Set credentials from environment variables
    this.clientA.setCredentials({
      refresh_token: process.env.ACCOUNT_A_REFRESH_TOKEN,
    });

    this.clientB.setCredentials({
      refresh_token: process.env.ACCOUNT_B_REFRESH_TOKEN,
    });

    // Initialize Tasks API instances
    this.tasksApiA = google.tasks({ version: 'v1', auth: this.clientA });
    this.tasksApiB = google.tasks({ version: 'v1', auth: this.clientB });

    // Load sync state
    await this.loadSyncState();
  }

  private async loadSyncState() {
    try {
      const data = await fs.readFile(this.stateFile, 'utf-8');
      this.syncState = JSON.parse(data);
      core.notice('Loaded existing sync state');
    } catch (error) {
      core.notice('No existing sync state found, starting fresh');
      this.syncState = { tasks: {}, lastSyncTime: new Date(0).toISOString() };
    }
  }

  private async saveSyncState() {
    await fs.writeFile(this.stateFile, JSON.stringify(this.syncState, null, 2));
    core.notice('Sync state saved');
  }

  private async getTaskLists(tasksApi: any): Promise<TaskList[]> {
    return this.retryWithBackoff(async () => {
      const response = await tasksApi.tasklists.list();
      return response.data.items || [];
    }, 'getTaskLists');
  }

  private async getAllTasks(tasksApi: any, taskListId: string): Promise<Task[]> {
    const tasks: Task[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const response: any = await this.retryWithBackoff(async () => {
        return await tasksApi.tasks.list({
          tasklist: taskListId,
          showCompleted: true,
          showHidden: true,
          maxResults: 100,
          pageToken: pageToken,
        });
      }, `getAllTasks (page ${pageToken || 'first'})`);

      if (response.data.items) {
        tasks.push(...response.data.items);
      }

      pageToken = response.data.nextPageToken;
      
      // Add a small delay between pages to avoid rate limiting
      if (pageToken) {
        await this.sleep(200);
      }
    } while (pageToken);

    return tasks;
  }

  private async createTask(tasksApi: any, taskListId: string, task: Partial<Task>): Promise<Task> {
    return this.retryWithBackoff(async () => {
      const response = await tasksApi.tasks.insert({
        tasklist: taskListId,
        requestBody: {
          title: task.title,
          notes: task.notes,
          status: task.status,
          due: task.due,
        },
      });
      return response.data;
    }, `createTask: ${task.title}`);
  }

  private async updateTask(tasksApi: any, taskListId: string, taskId: string, task: Partial<Task>): Promise<Task> {
    if (!taskId) {
      throw new Error('Cannot update task: taskId is missing');
    }
    return this.retryWithBackoff(async () => {
      const response = await tasksApi.tasks.update({
        tasklist: taskListId,
        task: taskId,
        requestBody: {
          id: taskId, // Explicitly include the ID
          title: task.title,
          notes: task.notes,
          status: task.status,
          due: task.due,
        },
      });
      return response.data;
    }, `updateTask: ${task.title}`);
  }

  private async deleteTask(tasksApi: any, taskListId: string, taskId: string) {
    return this.retryWithBackoff(async () => {
      await tasksApi.tasks.delete({
        tasklist: taskListId,
        task: taskId,
      });
    }, `deleteTask: ${taskId}`);
  }

  private shouldSyncTask(taskUpdated: string, lastSynced: string): boolean {
    return new Date(taskUpdated) > new Date(lastSynced);
  }

  private tasksAreEqual(task1: Task, task2: Task): boolean {
    return (
      task1.title === task2.title &&
      task1.notes === task2.notes &&
      task1.status === task2.status &&
      task1.due === task2.due
    );
  }

  private async findTaskListByName(tasksApi: any, listName: string): Promise<TaskList | null> {
    const lists = await this.getTaskLists(tasksApi);
    return lists.find(list => list.title === listName) || null;
  }

  async syncTaskLists() {
    core.startGroup('Sync Group');
    core.info('Starting sync...');

    // Get task lists from both accounts
    const taskListsA = await this.getTaskLists(this.tasksApiA);
    const taskListsB = await this.getTaskLists(this.tasksApiB);

    if (taskListsA.length === 0 || taskListsB.length === 0) {
      core.notice('No task lists found in one or both accounts');
      return;
    }

    // You can customize which lists to sync here:
    // Option 1: Use default list (first one)
    let taskListA = taskListsA[0];
    let taskListB = taskListsB[0];

    // Option 2: Sync specific lists by name from environment variables
    const targetListName = process.env.TASK_LIST_NAME;
    if (targetListName) {
      const foundListA = await this.findTaskListByName(this.tasksApiA, targetListName);
      const foundListB = await this.findTaskListByName(this.tasksApiB, targetListName);
      
      if (foundListA && foundListB) {
        taskListA = foundListA;
        taskListB = foundListB;
        core.notice(`Syncing specific list: "${targetListName}"`);
      } else {
        core.warning(`Warning: Task list "${targetListName}" not found in both accounts, using default list`);
      }
    }

    // Option 3: You can also hardcode specific list names here:
    // const taskListA = await this.findTaskListByName(this.tasksApiA, 'Work Tasks');
    // const taskListB = await this.findTaskListByName(this.tasksApiB, 'Work Tasks');
    // if (!taskListA || !taskListB) {
    //   core.error('Could not find "Work Tasks" list in both accounts');
    //   return;
    // }

    core.notice(`Syncing: Account A (${taskListA.title}) <-> Account B (${taskListB.title})`);

    // Fetch all tasks from both accounts
    const tasksA = await this.getAllTasks(this.tasksApiA, taskListA.id);
    const tasksB = await this.getAllTasks(this.tasksApiB, taskListB.id);

    core.notice(`Found ${tasksA.length} tasks in Account A, ${tasksB.length} tasks in Account B`);

    // Create maps for easier lookup
    const tasksAMap = new Map(tasksA.map(t => [t.id, t]));
    const tasksBMap = new Map(tasksB.map(t => [t.id, t]));

    // Track which tasks we've processed
    const processedPairs = new Set<string>();

    // Process tasks from Account A
    for (const taskA of tasksA) {
      const syncRecord = Object.values(this.syncState.tasks).find(
        r => r.accountAId === taskA.id
      );

      if (syncRecord) {
        // This task has been synced before
        const taskB = tasksBMap.get(syncRecord.accountBId);
        
        if (taskB) {
          // Both tasks exist - check for updates
          const aUpdated = new Date(taskA.updated);
          const bUpdated = new Date(taskB.updated);
          const lastSynced = new Date(syncRecord.lastSyncedUpdate);

          const aModified = aUpdated > lastSynced;
          const bModified = bUpdated > lastSynced;

          core.info(`Checking task: ${taskA.title}`);
          core.info(`  A updated: ${taskA.updated}, B updated: ${taskB.updated}, Last synced: ${syncRecord.lastSyncedUpdate}`);
          core.info(`  A modified: ${aModified}, B modified: ${bModified}`);

          if (aModified && bModified) {
            // Conflict: both modified since last sync - use latest timestamp
            if (aUpdated > bUpdated) {
              core.info(`Conflict resolved: A -> B (${taskA.title})`);
              try {
                // Only update if content actually differs
                if (!this.tasksAreEqual(taskA, taskB)) {
                  await this.updateTask(this.tasksApiB, taskListB.id, taskB.id, taskA);
                }
                syncRecord.lastSyncedUpdate = taskA.updated;
              } catch (error: any) {
                core.error(`Failed to update task in B. Code: ${error.code} Message: ${error.message}`);
                // Remove from sync state if task no longer exists
                if (error.code === 404 || error.code === 400) {
                  delete this.syncState.tasks[`${syncRecord.accountAId}-${syncRecord.accountBId}`];
                }
              }
            } else {
              core.info(`Conflict resolved: B -> A (${taskB.title})`);
              try {
                if (!this.tasksAreEqual(taskA, taskB)) {
                  await this.updateTask(this.tasksApiA, taskListA.id, taskA.id, taskB);
                }
                syncRecord.lastSyncedUpdate = taskB.updated;
              } catch (error: any) {
                core.error(`Failed to update task in A. Code: ${error.code} Message: ${error.message}`);
                if (error.code === 404 || error.code === 400) {
                  delete this.syncState.tasks[`${syncRecord.accountAId}-${syncRecord.accountBId}`];
                }
              }
            }
          } else if (aModified) {
            // Only A was modified
            core.info(`Syncing A -> B: ${taskA.title}`);
            try {
              if (!this.tasksAreEqual(taskA, taskB)) {
                await this.updateTask(this.tasksApiB, taskListB.id, taskB.id, taskA);
              } else {
                core.info(`  Content identical, skipping update`);
              }
              syncRecord.lastSyncedUpdate = taskA.updated;
            } catch (error: any) {
              core.error(`Failed to update task in B. Code: ${error.code} Message: ${error.message}`);
              if (error.code === 404 || error.code === 400) {
                delete this.syncState.tasks[`${syncRecord.accountAId}-${syncRecord.accountBId}`];
              }
            }
          } else if (bModified) {
            // Only B was modified
            core.info(`Syncing B -> A: ${taskB.title}`);
            try {
              if (!this.tasksAreEqual(taskA, taskB)) {
                await this.updateTask(this.tasksApiA, taskListA.id, taskA.id, taskB);
              } else {
                core.info(`  Content identical, skipping update`);
              }
              syncRecord.lastSyncedUpdate = taskB.updated;
            } catch (error: any) {
              core.error(`Failed to update task in A. Code: ${error.code} Message: ${error.message}`);
              if (error.code === 404 || error.code === 400) {
                delete this.syncState.tasks[`${syncRecord.accountAId}-${syncRecord.accountBId}`];
              }
            }
          } else {
            core.info(`No changes for task: ${taskA.title}`);
          }

          processedPairs.add(`${syncRecord.accountAId}-${syncRecord.accountBId}`);
        } else {
          // Task exists in A and sync record, but not in B - deleted from B
          core.info(`Deleting from A (deleted in B): ${taskA.title}`);
          try {
            await this.deleteTask(this.tasksApiA, taskListA.id, taskA.id);
          } catch (error: any) {
            core.error(`Failed to delete task from A. Code: ${error.code} Message: ${error.message}`);
          }
          delete this.syncState.tasks[`${syncRecord.accountAId}-${syncRecord.accountBId}`];
        }
      } else {
        // New task in A - create in B
        core.info(`New task in A, creating in B: ${taskA.title}`);
        try {
          const newTaskB = await this.createTask(this.tasksApiB, taskListB.id, taskA);
          this.syncState.tasks[`${taskA.id}-${newTaskB.id}`] = {
            accountAId: taskA.id,
            accountBId: newTaskB.id,
            lastSyncedUpdate: taskA.updated,
          };
          processedPairs.add(`${taskA.id}-${newTaskB.id}`);
        } catch (error: any) {
          core.error(`Failed to create task in B. Code: ${error.code} Message: ${error.message}`);
        }
      }
    }

    // Process tasks from Account B that haven't been processed yet
    for (const taskB of tasksB) {
      const syncRecord = Object.values(this.syncState.tasks).find(
        r => r.accountBId === taskB.id
      );

      if (syncRecord) {
        const pairKey = `${syncRecord.accountAId}-${syncRecord.accountBId}`;
        if (processedPairs.has(pairKey)) {
          continue; // Already processed
        }

        // Task exists in B and sync record, but not in A - deleted from A
        core.info(`Deleting from B (deleted in A): ${taskB.title}`);
        try {
          await this.deleteTask(this.tasksApiB, taskListB.id, taskB.id);
        } catch (error: any) {
          core.error(`Failed to delete task from B. Code: ${error.code} Message: ${error.message}`);
        }
        delete this.syncState.tasks[pairKey];
      } else {
        // New task in B - create in A
        core.info(`New task in B, creating in A: ${taskB.title}`);
        try {
          const newTaskA = await this.createTask(this.tasksApiA, taskListA.id, taskB);
          this.syncState.tasks[`${newTaskA.id}-${taskB.id}`] = {
            accountAId: newTaskA.id,
            accountBId: taskB.id,
            lastSyncedUpdate: taskB.updated,
          };
        } catch (error: any) {
          core.error(`Failed to create task in A. Code: ${error.code} Message: ${error.message}`);
        }
      }
    }

    this.syncState.lastSyncTime = new Date().toISOString();
    await this.saveSyncState();
    core.info('Sync completed successfully!');
    core.endGroup();
  }
}

// Main execution
async function main() {
  try {
    const sync = new GoogleTasksSync();
    await sync.initialize();
    await sync.syncTaskLists();
  } catch (error) {

    if (error instanceof Error) {
      core.error(`Sync failed: ${error.message}`);
      if (error.stack) {
        core.debug(error.stack); // Stack trace as debug info
      }
    } else {
      core.error(`Sync failed: ${String(error)}`);
    }
    process.exit(1);
  }
}

main();
