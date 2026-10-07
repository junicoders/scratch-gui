// Bridge that lets the parent page (Junicoders app) save and resume a
// student's Scratch project across sessions via postMessage, since the
// stock scratch-gui has no such hook when embedded in an iframe.
import {vmInitialState} from '../reducers/vm.js';

const vm = vmInitialState;

const uint8ToBase64 = bytes => {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return window.btoa(binary);
};

const base64ToUint8 = base64 => {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
};

let saveTimer = null;
// True between a project change and the save that captures it.
let unsavedChanges = false;

// requestId is set when the parent asked for this save (JUNI_REQUEST_SAVE) and
// is echoed back so it can tell its reply apart from a debounced autosave.
const sendSave = requestId => {
    unsavedChanges = false;
    vm.saveProjectSb3()
        .then(blob => {
            const reader = new FileReader();
            reader.onload = () => {
                const base64 = uint8ToBase64(new Uint8Array(reader.result));
                let code = '';
                try {
                    // Textual snapshot of the project's blocks (opcodes, field values, variable
                    // names) used by the parent app to verify a challenge's required block/keyword.
                    code = JSON.stringify(vm.toJSON());
                } catch (e) {
                    // ignore; verification will simply not match
                }
                window.parent.postMessage({type: 'JUNI_SAVE_PROJECT', payload: base64, code, requestId}, '*');
            };
            reader.readAsArrayBuffer(blob);
        })
        .catch(() => {
            // The changes still haven't been saved anywhere.
            unsavedChanges = true;
            // Autosaves ignore transient failures (e.g. mid-load); a requested
            // save reports it, so the parent doesn't wait for a reply that
            // will never come.
            if (requestId) {
                window.parent.postMessage({type: 'JUNI_SAVE_FAILED', requestId}, '*');
            }
        });
};

const scheduleSave = () => {
    unsavedChanges = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => sendSave(), 4000);
};

let initialSnapshotSent = false;
let loadInProgress = false;

// Snapshot the true starting state (blank, or resumed) so the parent app can
// tell "did the student actually change anything" apart from whatever the
// first debounced PROJECT_CHANGED save happens to capture — without this,
// several quick edits made before that first save fires all get folded into
// the comparison baseline instead of counting as real work.
const sendInitialSnapshot = () => {
    if (initialSnapshotSent) return;
    initialSnapshotSent = true;
    let code = '';
    try {
        code = JSON.stringify(vm.toJSON());
    } catch (e) {
        // ignore; baseline will simply not be set
    }
    window.parent.postMessage({type: 'JUNI_INITIAL_CODE', code}, '*');
};

window.addEventListener('message', event => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'JUNI_LOAD_PROJECT' && data.payload) {
        loadInProgress = true;
        vm.loadProject(base64ToUint8(data.payload))
            .catch(() => {})
            .then(() => sendInitialSnapshot());
    } else if (data.type === 'JUNI_REQUEST_SAVE' && data.requestId) {
        // The parent needs the current state right now (e.g. before checking
        // the challenge or leaving the page), not whenever the debounced
        // autosave fires -- save immediately and drop the pending autosave.
        // onlyIfChanged (used when the student leaves the page): nothing to do
        // if every change already went out in an autosave.
        if (data.onlyIfChanged && !unsavedChanges) {
            window.parent.postMessage({type: 'JUNI_SAVE_PROJECT', requestId: data.requestId, unchanged: true}, '*');
            return;
        }
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = null;
        sendSave(data.requestId);
    }
});

vm.runtime.on('PROJECT_CHANGED', scheduleSave);

const announceReady = () => {
    // Let the parent know it's safe to send a saved/starter project now.
    // saveRequests: this bridge answers JUNI_REQUEST_SAVE, so the parent can
    // rely on it instead of waiting for an autosave (older builds don't).
    window.parent.postMessage({type: 'JUNI_SCRATCH_READY', saveRequests: true}, '*');

    // If the parent doesn't send a project to resume (starting fresh),
    // snapshot the blank starting state shortly after ready.
    setTimeout(() => {
        if (!loadInProgress) sendInitialSnapshot();
    }, 300);
};

// scratch-gui's own app bootstrap loads its default project (the classic cat +
// blank stage) asynchronously in the background, via the SAME vm instance we
// use here. If we announce ready immediately, the parent's reply -- our own
// vm.loadProject(customData) call -- can land while that default load is still
// in flight: two concurrent loadProject calls on one VM don't cleanly replace
// each other, so both end up installing their sprites/backdrops, and the
// default cat/blank-stage ends up coexisting with whatever we tried to load.
// Wrapping loadProject lets us wait for that first (bootstrap) call to settle
// before ever telling the parent we're ready, so our own load always happens
// strictly after -- never racing it.
const originalLoadProject = vm.loadProject.bind(vm);
let readyScheduled = false;
vm.loadProject = function (...args) {
    const promise = originalLoadProject(...args);
    if (!readyScheduled) {
        readyScheduled = true;
        promise.then(announceReady, announceReady);
    }
    return promise;
};
