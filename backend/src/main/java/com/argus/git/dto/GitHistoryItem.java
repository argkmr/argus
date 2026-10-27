package com.argus.git.dto;

public record GitHistoryItem(
    String hash, String shortHash, String author, String date, String subject, String refs) {}
