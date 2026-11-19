import { Storage } from "@google-cloud/storage";
import { ResultHistoryGcsStore } from "@aerodb/core/result-history-storage";

export class ResultHistoryStore extends ResultHistoryGcsStore {
  constructor(storage = new Storage()) {
    super(storage);
  }
}
