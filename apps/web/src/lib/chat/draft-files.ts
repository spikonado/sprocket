let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
	if (!database) {
		database = new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('sprocket-draft-files', 1);
			request.onupgradeneeded = () => request.result.createObjectStore('files');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		}).catch((error) => {
			database = undefined;
			throw error;
		});
	}
	return database;
}

async function fileRequest<T>(
	mode: IDBTransactionMode,
	operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
	const db = await openDatabase();
	return new Promise((resolve, reject) => {
		const transaction = db.transaction('files', mode);
		const request = operation(transaction.objectStore('files'));
		transaction.oncomplete = () => resolve(request.result);
		transaction.onabort = () =>
			reject(transaction.error ?? new Error('Could not save draft file.'));
		transaction.onerror = () => reject(transaction.error);
	});
}

export function saveDraftFile(userId: string, localId: string, file: Blob) {
	return fileRequest('readwrite', (store) => store.put(file, [userId, localId]));
}

export async function loadDraftFile(userId: string, localId: string): Promise<Blob | null> {
	const file: unknown = await fileRequest('readonly', (store) => store.get([userId, localId]));
	return file instanceof Blob ? file : null;
}

export function deleteDraftFile(userId: string, localId: string) {
	return fileRequest('readwrite', (store) => store.delete([userId, localId]));
}
