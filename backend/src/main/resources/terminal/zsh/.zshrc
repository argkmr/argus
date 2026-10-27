# macOS /etc/zshrc derives its default history path before this shim runs.
# Redirect only that temporary default; explicit user history settings stay intact.
if [[ $HISTFILE == "$_argus_integration_dir/.zsh_history" ]]; then
  HISTFILE="$_argus_user_zdotdir/.zsh_history"
fi
_argus_before_startup .zshrc
[[ -f $_argus_startup_file ]] && builtin source "$_argus_startup_file"
_argus_after_startup
