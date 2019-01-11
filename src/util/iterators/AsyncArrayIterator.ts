import { BufferedIterator } from "asynciterator";
import { DurationMs } from "../../interfaces/units";

export default class AsyncArrayIterator<T> extends BufferedIterator<T> {
  private currentIndex: number = 0;
  private readonly array: T[];
  private readonly interval: DurationMs;

  constructor(array: T[], interval: DurationMs = 0) {
    super();

    this.array = array;
    this.interval = interval;
  }

  public _read(count: number, done: () => void): void {
    if (this.currentIndex === this.array.length) {
      this.close();
      return done();
    }

    const self = this;

    setTimeout(() => {
      self._push(self.array[self.currentIndex++]);
      done();
    }, this.interval);
  }
}
