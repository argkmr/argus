# Load the normal user startup files without modifying them or inheriting our
# temporary ZDOTDIR in child shells. Values arrive as environment data, not code.
typeset -g _argus_integration_dir=$ARGUS_ZSH_INTEGRATION
typeset -g _argus_user_zdotdir=$ARGUS_ORIGINAL_ZDOTDIR
typeset -g _argus_user_zdotdir_set=$ARGUS_ORIGINAL_ZDOTDIR_SET
typeset -g _argus_user_prompt_changed=0
function _argus_before_startup() {
  typeset -g _argus_startup_file="$_argus_user_zdotdir/$1"
  typeset -g _argus_prompt_before=$PROMPT
  if [[ $_argus_user_zdotdir_set == 1 ]]; then
    export ZDOTDIR=$_argus_user_zdotdir
  else
    unset ZDOTDIR
  fi
}
function _argus_after_startup() {
  [[ $PROMPT != $_argus_prompt_before ]] && _argus_user_prompt_changed=1
  _argus_user_zdotdir_set=${+ZDOTDIR}
  _argus_user_zdotdir=${ZDOTDIR:-$HOME}
  if [[ -o rcs ]]; then
    export ZDOTDIR=$_argus_integration_dir
  elif [[ $_argus_user_zdotdir_set == 1 ]]; then
    export ZDOTDIR=$_argus_user_zdotdir
  else
    unset ZDOTDIR
  fi
  return 0
}
_argus_before_startup .zshenv
[[ -f $_argus_startup_file ]] && builtin source "$_argus_startup_file"
_argus_after_startup
