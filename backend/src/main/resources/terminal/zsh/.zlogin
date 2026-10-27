_argus_before_startup .zlogin
[[ -f $_argus_startup_file ]] && builtin source "$_argus_startup_file"
_argus_after_startup

# Leave existing themes and prompt hooks alone. A clean zsh receives the compact
# directory/branch prompt; names are data, escaped for zsh prompt expansion.
typeset -g _argus_fallback_prompt=0
if [[ $_argus_user_prompt_changed == 0 && ${#precmd_functions[@]} == 0 ]] && (( ! $+functions[precmd] )); then
  _argus_fallback_prompt=1
  setopt PROMPT_SUBST
  PROMPT='%F{green}➜%f %F{cyan}${_argus_prompt_directory}%f${_argus_prompt_git} '
fi
function _argus_terminal_precmd() {
  local _argus_previous_status=$?
  builtin print -rn -- "$PWD" >| "$_argus_integration_dir/cwd" 2>/dev/null
  if [[ $_argus_fallback_prompt == 1 ]]; then
    local _argus_branch _argus_directory=${PWD:t}
    [[ $PWD == $HOME ]] && _argus_directory='~'
    [[ -z $_argus_directory ]] && _argus_directory='/'
    _argus_branch=$(command git symbolic-ref --quiet --short HEAD 2>/dev/null) ||
      _argus_branch=$(command git rev-parse --short HEAD 2>/dev/null)
    # (V) makes controls visible; doubling '%' avoids interpreting branch/path
    # names as prompt escapes. The fixed PROMPT expands variables once; their
    # contents are never parsed as shell commands, even for names with '$()'.
    _argus_directory=${(V)_argus_directory}
    _argus_branch=${(V)_argus_branch}
    typeset -g _argus_prompt_directory=${_argus_directory//\%/%%}
    typeset -g _argus_prompt_git=''
    [[ -n $_argus_branch ]] && _argus_prompt_git=' %F{blue}git:(%F{red}'${_argus_branch//\%/%%}'%F{blue})%f'
  fi
  return $_argus_previous_status
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd _argus_terminal_precmd
if [[ $_argus_user_zdotdir_set == 1 ]]; then
  export ZDOTDIR=$_argus_user_zdotdir
else
  unset ZDOTDIR
fi
unset ARGUS_ORIGINAL_ZDOTDIR ARGUS_ORIGINAL_ZDOTDIR_SET ARGUS_ZSH_INTEGRATION
unfunction _argus_before_startup _argus_after_startup
