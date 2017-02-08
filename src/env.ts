// The MIT License (MIT)
//
// Copyright (c) 2015 Firebase
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import * as _ from 'lodash';
import * as request from 'request-promise';
import * as firebase from 'firebase-admin';

export function env(): env.Env {
  return env.singleton;
}

export namespace env {
  /** @internal */
  export let singleton: env.Env;

  export let init = (credential: firebase.credential.Credential) => {
    singleton = new RuntimeConfigEnv(credential, process.env.GCLOUD_PROJECT);
  };

  export interface Env {
    data: Data;
    ready(): PromiseLike<any>;
    observe(callback: (data: Data) => void): void;
  }

  // Data is usable as an object (dot-notation is allowed) and the firebase property is known for
  // code complete.
  export type Data = Object & {firebase?: Object}

  interface Metadata {
    version: string;
    reserved?: Data;
    latest?: Data;
  }

  export class AbstractEnv implements Env {
    protected _ready: boolean;
    protected _readyError: any;
    protected _readyListeners: { resolve: Function, reject: Function }[];
    protected _observers: ((data: Data) => void)[];

    constructor() {
      this._readyListeners = [];
      this._observers = [];
    }

    ready(): PromiseLike<any> {
      if (this._ready) {
        return this._readyError ? Promise.reject(this._readyError) : Promise.resolve();
      }

      return new Promise((resolve, reject) => {
        this._readyListeners.push({resolve, reject});
      });
    }

    get data(): Data {
      throw new Error('Firebase: unimplemented data getter in environment');
    }

    observe(callback: (data: Data) => void): void {
      this._observers.push(callback);
    }

    protected _notifyReady(err?: any) {
      this._ready = true;
      while (this._readyListeners.length) {
        let listener = this._readyListeners.shift();
        err ? listener.reject(err) : listener.resolve();
      }
    }

    protected _notifyObservers(data: Data) {
      for (let observer of this._observers) {
        observer(data);
      }
    }
  }

  export class RuntimeConfigEnv extends AbstractEnv {
    credential: firebase.credential.Credential;
    lastUpdated: string;
    projectId: string;
    version: string;
    private _custom: Data;
    private _customFromMeta: Data;
    private _reserved: Data;
    private _merged: Data;
    private _watching: boolean;

    constructor(credential, projectId) {
      super();
      [this.credential, this.projectId, this.lastUpdated] = [credential, projectId, new Date(0).toISOString()];
      if (this.credential && this.projectId) {
        this.watch();
      }
    }

    private request(options: request.Options): PromiseLike<any> {
      return this.credential.getAccessToken().then(tokenResponse => {
        options.headers = options.headers || {};
        _.assign(options.headers, {
          Authorization: `Bearer ${tokenResponse.access_token}`,
        });

        return request(options);
      });
    }

    private watch() {
      if (!this._watching) {
        this._watching = true;
        return this.request({
          method: 'POST',
          url: `${this.varurl('meta')}:watch`,
          body: {
            newerThan: this.lastUpdated,
          },
          json: true,
          timeout: 65000, // watch times out in 60s
        }).then(response => {
          if (response.state === 'UPDATED') {
            // response is a JSON object with JSON encoded in the "text" field
            this._meta = JSON.parse(response.text);
            this.lastUpdated = response.updateTime;

            console.log(`Firebase: detected environment version ${this.version}, activating...`);
            this.fetch();
          } else if (response.state === 'DELETED') {
            this._notifyObservers({});
            this._custom = {};
            this.version = null;
            this.lastUpdated = response.updateTime;
          }
        }, err => {
          if (_.get(err, 'response.statusCode') === 502) {
            return Promise.resolve();
          }

          return Promise.reject(err);
        }).then(() => {
          this._watching = false;
          this.watch();
        });
      }
    }

    private fetch(): PromiseLike<Env> {
      let fetched = Promise.resolve(this._customFromMeta || this.fetchVar(this.version));

      return fetched.then((data: Data) => {
        console.log('Firebase: activated environment configuration', this.version);
        this._merged = null;
        this._custom = data || {};
        this._notifyReady();
        this._notifyObservers(data);
        return this._custom;
      }, err => {
        console.warn('Firebase: error fetching environment configuration. Error:', err.stack);
        this._merged = null;
        this._custom = {};
        this._notifyReady(err);
        return this._custom;
      });
    }

    private fetchVar(name: string): PromiseLike<any> {
      if (name === 'v0') {
        return Promise.resolve({});
      }

      return this.request({
        method: 'GET',
        url: this.varurl(name),
        json: true,
      }).then(response => {
        try {
          return JSON.parse(response.text);
        } catch (e) {
          console.log('Firebase: invalid stored environment config content:', response.text);

          return null;
        }
      });
    }

    private set _meta(meta: Metadata) {
      this.version = meta.version || 'v0';
      this._reserved = meta.reserved || {};
      this._merged = null;

      if (meta.latest) {
        this._customFromMeta = meta.latest;
      }
    }

    get data(): Data {
      if (!this._ready) {
        throw new Error('Firebase: cannot access env before it is ready');
      } else if (this._merged) {
        return this._merged;
      }

      this._merged = _.assign({}, this._custom, this._reserved);
      if (this.credential) {
        _.set(this._merged, 'firebase.credential', this.credential);
      }
      return this._merged;
    }

    private varurl(name: string): string {
      return `https://runtimeconfig.googleapis.com/v1beta1/${this.varname(name)}`;
    }

    private varname(name: string): string {
      return `projects/${this.projectId}/configs/firebase/variables/${name}`;
    }
  }
}
