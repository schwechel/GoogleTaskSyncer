import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import * as fs from 'fs/promises';
import * as path from 'path';

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

  constructor() {
    this.stateFile = path.join(process.cwd(), 'sync-state.json');
    this.syncState = { tasks: {}, lastSyncTime: new Date(0).toISOString() };
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
      console.log('Loaded existing sync state');
    } catch (error) {
      console.log('No existing sync state found, starting fresh');
      this.syncState = { tasks: {}, lastSyncTime: new Date(0).toISOString() };
    }
  }

  private async saveSyncState() {
    await fs.writeFile(this.stateFile, JSON.stringify(this.syncState, null, 2));
    console.log('Sync state saved');
  }

  private async getTaskLists(tasksApi: any): Promise<TaskList[]> {
    const response = await tasksApi.tasklists.list();
    return response.data.items || [];
  }

  private async getAllTasks(tasksApi: any, taskListId: string): Promise<Task[]> {
    const tasks: Task[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const response = await tasksApi.tasks.list({
        tasklist: taskListId,
        showCompleted: true,
        showHidden: true,
        maxResults: 2,
        pageToken: pageToken,
      });

      if (response.data.items) {
        tasks.push(...response.data.items);
      }

      pageToken = response.data.nextPageToken;
    } while (pageToken);

    return tasks;
  }

  private async createTask(tasksApi: any, taskListId: string, task: Partial<Task>): Promise<Task> {
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
  }

  private async updateTask(tasksApi: any, taskListId: string, taskId: string, task: Partial<Task>): Promise<Task> {
    if (!taskId) {
      throw new Error('Cannot update task: taskId is missing');
    }
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
  }

  private async deleteTask(tasksApi: any, taskListId: string, taskId: string) {
    await tasksApi.tasks.delete({
      tasklist: taskListId,
      task: taskId,
    });
  }

  private shouldSyncTask(taskUpdated: string, lastSynced: string): boolean {
    return new Date(taskUpdated) > new Date(lastSynced);
  }

  private async findTaskListByName(tasksApi: any, listName: string): Promise<TaskList | null> {
    const lists = await this.getTaskLists(tasksApi);
    return lists.find(list => list.title === listName) || null;
  }

  async syncTaskLists() {
    console.log('Starting sync...');

    // Get task lists from both accounts
    const taskListsA = await this.getTaskLists(this.tasksApiA);
    const taskListsB = await this.getTaskLists(this.tasksApiB);

    if (taskListsA.length === 0 || taskListsB.length === 0) {
      console.error('No task lists found in one or both accounts');
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
        console.log(`Syncing specific list: "${targetListName}"`);
      } else {
        console.log(`Warning: Task list "${targetListName}" not found in both accounts, using default list`);
      }
    }

    // Option 3: You can also hardcode specific list names here:
    // const taskListA = await this.findTaskListByName(this.tasksApiA, 'Work Tasks');
    // const taskListB = await this.findTaskListByName(this.tasksApiB, 'Work Tasks');
    // if (!taskListA || !taskListB) {
    //   console.error('Could not find "Work Tasks" list in both accounts');
    //   return;
    // }

    console.log(`Syncing: Account A (${taskListA.title}) <-> Account B (${taskListB.title})`);

    // Fetch all tasks from both accounts
    const tasksA = await this.getAllTasks(this.tasksApiA, taskListA.id);
    const tasksB = await this.getAllTasks(this.tasksApiB, taskListB.id);

    console.log(`Found ${tasksA.length} tasks in Account A, ${tasksB.length} tasks in Account B`);

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

          if (aModified && bModified) {
            // Conflict: both modified since last sync - use latest timestamp
            if (aUpdated > bUpdated) {
              console.log(`Conflict resolved: A -> B (${taskA.title})`);
              try {
                await this.updateTask(this.tasksApiB, taskListB.id, taskB.id, taskA);
                syncRecord.lastSyncedUpdate = taskA.updated;
              } catch (error: any) {
                console.error(`Failed to update task in B: ${error.message}`);
                // Remove from sync state if task no longer exists
                if (error.code === 404 || error.code === 400) {
                  delete this.syncState.tasks[`${syncRecord.accountAId}-${syncRecord.accountBId}`];
                }
              }
            } else {
              console.log(`Conflict resolved: B -> A (${taskB.title})`);
              try {
                await this.updateTask(this.tasksApiA, taskListA.id, taskA.id, taskB);
                syncRecord.lastSyncedUpdate = taskB.updated;
              } catch (error: any) {
                console.error(`Failed to update task in A: ${error.message}`);
                if (error.code === 404 || error.code === 400) {
                  delete this.syncState.tasks[`${syncRecord.accountAId}-${syncRecord.accountBId}`];
                }
              }
            }
          } else if (aModified) {
            // Only A was modified
            console.log(`Syncing A -> B: ${taskA.title}`);
            try {
              await this.updateTask(this.tasksApiB, taskListB.id, taskB.id, taskA);
              syncRecord.lastSyncedUpdate = taskA.updated;
            } catch (error: any) {
              console.error(`Failed to update task in B: ${error.message}`);
              if (error.code === 404 || error.code === 400) {
                delete this.syncState.tasks[`${syncRecord.accountAId}-${syncRecord.accountBId}`];
              }
            }
          } else if (bModified) {
            // Only B was modified
            console.log(`Syncing B -> A: ${taskB.title}`);
            try {
              await this.updateTask(this.tasksApiA, taskListA.id, taskA.id, taskB);
              syncRecord.lastSyncedUpdate = taskB.updated;
            } catch (error: any) {
              console.error(`Failed to update task in A: ${error.message}`);
              if (error.code === 404 || error.code === 400) {
                delete this.syncState.tasks[`${syncRecord.accountAId}-${syncRecord.accountBId}`];
              }
            }
          }

          processedPairs.add(`${syncRecord.accountAId}-${syncRecord.accountBId}`);
        } else {
          // Task exists in A and sync record, but not in B - deleted from B
          console.log(`Deleting from A (deleted in B): ${taskA.title}`);
          try {
            await this.deleteTask(this.tasksApiA, taskListA.id, taskA.id);
          } catch (error: any) {
            console.error(`Failed to delete task from A: ${error.message}`);
          }
          delete this.syncState.tasks[`${syncRecord.accountAId}-${syncRecord.accountBId}`];
        }
      } else {
        // New task in A - create in B
        console.log(`New task in A, creating in B: ${taskA.title}`);
        try {
          const newTaskB = await this.createTask(this.tasksApiB, taskListB.id, taskA);
          this.syncState.tasks[`${taskA.id}-${newTaskB.id}`] = {
            accountAId: taskA.id,
            accountBId: newTaskB.id,
            lastSyncedUpdate: taskA.updated,
          };
          processedPairs.add(`${taskA.id}-${newTaskB.id}`);
        } catch (error: any) {
          console.error(`Failed to create task in B: ${error.message}`);
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
        console.log(`Deleting from B (deleted in A): ${taskB.title}`);
        try {
          await this.deleteTask(this.tasksApiB, taskListB.id, taskB.id);
        } catch (error: any) {
          console.error(`Failed to delete task from B: ${error.message}`);
        }
        delete this.syncState.tasks[pairKey];
      } else {
        // New task in B - create in A
        console.log(`New task in B, creating in A: ${taskB.title}`);
        try {
          const newTaskA = await this.createTask(this.tasksApiA, taskListA.id, taskB);
          this.syncState.tasks[`${newTaskA.id}-${taskB.id}`] = {
            accountAId: newTaskA.id,
            accountBId: taskB.id,
            lastSyncedUpdate: taskB.updated,
          };
        } catch (error: any) {
          console.error(`Failed to create task in A: ${error.message}`);
        }
      }
    }

    this.syncState.lastSyncTime = new Date().toISOString();
    await this.saveSyncState();
    console.log('Sync completed successfully!');
  }
}

// Main execution
async function main() {
  try {
    const sync = new GoogleTasksSync();
    await sync.initialize();
    await sync.syncTaskLists();
  } catch (error) {
    console.error('Sync failed:', error);
    process.exit(1);
  }
}

main();
