#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "run as root (for example: sudo $0)" >&2
  exit 1
fi

readonly shared_group="vps-repo-users"
readonly -a owner_accounts=(holyglory holygloryTT axel slawa)
readonly -a repository_paths=(
  /home/holyglory/XFoilFOAM
  /home/holyglory/.codex/worktrees/2e28/XFoilFOAM
  /home/holyglory/XFoilFOAM-cell-modal
  /tmp/airfoils-clean-release-a030
)

getent group "${shared_group}" >/dev/null

for account in "${owner_accounts[@]}"; do
  getent passwd "${account}" >/dev/null
  if ! id -nG "${account}" | tr ' ' '\n' | grep -Fxq "${shared_group}"; then
    echo "${account} is not a member of ${shared_group}" >&2
    exit 1
  fi
done

# Home directories expose traversal only. Repository and SSH-directory access
# is granted at the exact descendants below.
for account in "${owner_accounts[@]}"; do
  home_dir="$(getent passwd "${account}" | cut -d: -f6)"
  setfacl -b "${home_dir}"
  setfacl -k "${home_dir}"
  setfacl -m \
    "u:holyglory:--x,u:holygloryTT:--x,u:axel:--x,u:slawa:--x,g:${shared_group}:--x,m::rwx" \
    "${home_dir}"
done

# Existing content becomes group-writable and every directory inherits the
# same access for future files. setgid keeps the shared group on new entries.
for repository_path in "${repository_paths[@]}"; do
  if [[ ! -d "${repository_path}" ]]; then
    echo "missing repository/worktree: ${repository_path}" >&2
    exit 1
  fi
  setfacl -R -b "${repository_path}"
  find "${repository_path}" -type d -exec setfacl -k {} +
  chgrp -R "${shared_group}" "${repository_path}"
  chmod -R g+rwX "${repository_path}"
  setfacl -R -m \
    "u:holyglory:rwX,u:holygloryTT:rwX,u:axel:rwX,u:slawa:rwX,g:${shared_group}:rwX,m::rwx" \
    "${repository_path}"
  find "${repository_path}" -type d -exec chmod g+s {} +
  find "${repository_path}" -type d -exec \
    setfacl -m \
      "d:u:holyglory:rwx,d:u:holygloryTT:rwx,d:u:axel:rwx,d:u:slawa:rwx,d:g:${shared_group}:rwx,d:m::rwx" \
      {} +
done

private_key_list="$(mktemp)"
trap 'rm -f "${private_key_list}"' EXIT

# Fix the user-namespace ownership remap on each SSH directory without
# changing inbound authorized_keys contents, then inventory real outbound
# private keys by asking ssh-keygen to parse them.
for account in "${owner_accounts[@]}"; do
  account_entry="$(getent passwd "${account}")"
  account_group="$(id -gn "${account}")"
  home_dir="$(cut -d: -f6 <<<"${account_entry}")"
  ssh_dir="${home_dir}/.ssh"

  install -d -m 700 -o "${account}" -g "${account_group}" "${ssh_dir}"
  setfacl -R -b "${ssh_dir}"
  find "${ssh_dir}" -type d -exec setfacl -k {} +
  chown -R "${account}:${account_group}" "${ssh_dir}"
  chmod 700 "${ssh_dir}"
  [[ ! -f "${ssh_dir}/authorized_keys" ]] || chmod 600 "${ssh_dir}/authorized_keys"
  [[ ! -f "${ssh_dir}/config" ]] || chmod 600 "${ssh_dir}/config"

  while IFS= read -r -d '' candidate; do
    candidate_name="$(basename "${candidate}")"
    case "${candidate_name}" in
      authorized_keys|config|known_hosts|known_hosts.old|known_hosts_*|*.pub)
        continue
        ;;
    esac
    chmod 600 "${candidate}"
    if ssh-keygen -y -f "${candidate}" >/dev/null 2>&1; then
      printf '%s\n' "${candidate}" >>"${private_key_list}"
    fi
  done < <(find "${ssh_dir}" -maxdepth 1 -type f -print0)

  find "${ssh_dir}" -maxdepth 1 -type f -name '*.pub' -exec chmod 644 {} +
done

sort -u -o "${private_key_list}" "${private_key_list}"

# OpenSSH deliberately rejects a shared private-key inode with group-readable
# mode bits. Install one account-owned 0600 copy instead. Existing account
# configuration and inbound authorized_keys remain untouched.
for account in "${owner_accounts[@]}"; do
  account_group="$(id -gn "${account}")"
  home_dir="$(getent passwd "${account}" | cut -d: -f6)"
  shared_key_dir="${home_dir}/.ssh/shared-owner-keys"
  install -d -m 700 -o "${account}" -g "${account_group}" "${shared_key_dir}"

  while IFS= read -r private_key; do
    [[ -n "${private_key}" ]] || continue
    key_name="$(basename "${private_key}")"
    install -m 600 -o "${account}" -g "${account_group}" \
      "${private_key}" "${shared_key_dir}/${key_name}"
    if [[ -f "${private_key}.pub" ]]; then
      install -m 644 -o "${account}" -g "${account_group}" \
        "${private_key}.pub" "${shared_key_dir}/${key_name}.pub"
    fi
  done <"${private_key_list}"

  # Preserve each account's host-key databases as separately named sources;
  # do not merge or overwrite its active known_hosts file.
  for source_account in "${owner_accounts[@]}"; do
    source_home="$(getent passwd "${source_account}" | cut -d: -f6)"
    for host_file in known_hosts known_hosts.old known_hosts_hz_solver2 google_compute_known_hosts; do
      source_file="${source_home}/.ssh/${host_file}"
      [[ -f "${source_file}" ]] || continue
      install -m 600 -o "${account}" -g "${account_group}" \
        "${source_file}" \
        "${shared_key_dir}/${source_account}-${host_file}"
    done
  done
done

echo "shared repository access configured for: ${owner_accounts[*]}"
echo "validated private keys installed per account: $(wc -l <"${private_key_list}")"
