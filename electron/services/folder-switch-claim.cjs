"use strict";

// A folder switch reserves the folder it goes to before anything else, so a
// collaboration session is not ended for a folder another window holds. Until
// the switch goes ahead, a refusal anywhere in it (its own checks, or when its
// writer leases are taken just after them) gives that reservation back; the
// folder open now stays claimed. workspace.setRootPath then keeps only the new
// folder (main.cjs).
//
//   lock          WorkspaceWindowLock (claimAsync, keepOnly)
//   currentRoot() the folder open now (null: none)
//   takenError()  the error for a folder another window has open
const createFolderSwitchClaim = ({ lock, currentRoot, takenError }) => {
  let pending = null;
  const rollback = () => {
    if (!pending) return;
    pending = null;
    lock.keepOnly(currentRoot());
  };
  return {
    // beforeChange: reserve `toRootPath`, then run the switch's checks.
    async reserve(toRootPath, checks) {
      lock.keepOnly(currentRoot());
      // Opening and project writes remain available when folder lock storage fails.
      if (!await lock.claimAsync(toRootPath)) throw takenError();
      const claim = { toRootPath, armed: false };
      pending = claim;
      try {
        await checks();
      } catch (error) {
        if (pending === claim) rollback();
        throw error;
      }
      // The writer leases follow in the same turn (project-handlers.cjs).
      claim.armed = true;
    },
    // Wraps every renderer writer lease; only those of a switch whose checks
    // passed decide its reservation: the new folder's lease lets it go ahead,
    // a refused one gives the reservation back.
    leased(rootPath, begin) {
      let release;
      try {
        release = begin();
      } catch (error) {
        if (pending?.armed) rollback();
        throw error;
      }
      if (pending?.armed && rootPath === pending.toRootPath) pending = null;
      return release;
    },
  };
};

module.exports = { createFolderSwitchClaim };
